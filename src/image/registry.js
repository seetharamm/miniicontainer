'use strict';
/**
 * Pluggable registry client.
 *
 * Supports:
 *   - Docker Hub  (registry-1.docker.io)
 *   - Any OCI-compliant private registry  (e.g. ghcr.io, quay.io, localhost:5000)
 *
 * Authentication:
 *   - Anonymous (public Docker Hub images)
 *   - Docker Hub username/password  → DOCKER_USERNAME + DOCKER_PASSWORD env vars
 *   - Bearer token challenge (WWW-Authenticate)  → used by ghcr.io, quay.io, etc.
 *   - HTTP Basic  → used by simple private registries
 *
 * Usage:
 *   const client = new RegistryClient('eclipse-temurin:21-jre');
 *   const manifest = await client.resolveManifest();
 *   await client.downloadBlob(digest, destPath, onProgress);
 */

const axios = require('axios');
const fs    = require('fs');

// ── media-type constants ──────────────────────────────────────────────────────
const MT = {
  MANIFEST_V2:      'application/vnd.docker.distribution.manifest.v2+json',
  MANIFEST_OCI:     'application/vnd.oci.image.manifest.v1+json',
  MANIFEST_LIST:    'application/vnd.docker.distribution.manifest.list.v2+json',
  MANIFEST_OCI_IDX: 'application/vnd.oci.image.index.v1+json',
  MANIFEST_V1:      'application/vnd.docker.distribution.manifest.v1+prettyjws',
  CONFIG:           'application/vnd.docker.container.image.v1+json',
  LAYER_GZIP:       'application/vnd.docker.image.rootfs.diff.tar.gzip',
  LAYER_OCI_GZIP:   'application/vnd.oci.image.layer.v1.tar+gzip',
  LAYER_OCI_ZSTD:   'application/vnd.oci.image.layer.v1.tar+zstd',
};

// Node.js arch  →  OCI arch
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse an image reference into its components.
 *
 * Handles all of:
 *   alpine
 *   alpine:3.19
 *   ubuntu:22.04
 *   myrepo/myimage:tag
 *   ghcr.io/owner/image:tag
 *   localhost:5000/myimage:latest
 *   registry.example.com:443/org/image:sha256:abc123
 *
 * Returns { registry, repo, tag, isDockerHub }
 */
function parseRef(ref) {
  // Digest reference?  image@sha256:abc
  let digest = null;
  if (ref.includes('@')) {
    [ref, digest] = ref.split('@');
  }

  // Split off the tag — last colon that's NOT part of a port or digest
  let tag = 'latest';
  // Find the last '/' first, then look for ':' after it
  const lastSlash = ref.lastIndexOf('/');
  const namepart  = ref.slice(lastSlash + 1);
  const colonIdx  = namepart.lastIndexOf(':');
  if (colonIdx !== -1) {
    tag = namepart.slice(colonIdx + 1);
    ref = ref.slice(0, lastSlash + 1) + namepart.slice(0, colonIdx);
  }

  if (digest) tag = digest; // pull by digest overrides tag

  // Does the first component look like a hostname?
  const parts = ref.split('/');
  let registry    = 'registry-1.docker.io';
  let isDockerHub = true;
  let repo        = ref;

  if (parts.length > 1) {
    const first = parts[0];
    // A hostname contains a dot, a colon (port), or is "localhost"
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry    = first;
      repo        = parts.slice(1).join('/');
      isDockerHub = false;
    }
  }

  // Docker Hub short names (alpine → library/alpine)
  if (isDockerHub && !repo.includes('/')) {
    repo = `library/${repo}`;
  }

  return { registry, repo, tag, digest, isDockerHub };
}

// ── RegistryClient ─────────────────────────────────────────────────────────────

class RegistryClient {
  /**
   * @param {string} imageRef   Full image reference, e.g. "eclipse-temurin:21-jre"
   * @param {object} [authOpts] Optional override: { username, password, token }
   */
  constructor(imageRef, authOpts = {}) {
    const parsed       = parseRef(imageRef);
    this.registry      = parsed.registry;
    this.repo          = parsed.repo;
    this.tag           = parsed.tag;
    this.digest        = parsed.digest;
    this.isDockerHub   = parsed.isDockerHub;
    this.authOpts      = authOpts;
    this._token        = null;
    this._tokenExpiry  = 0;
  }

  get baseUrl() {
    const scheme = this.registry.startsWith('localhost') ||
                   this.registry.match(/^127\./) ? 'http' : 'https';
    return `${scheme}://${this.registry}/v2`;
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  /**
   * Obtain a Bearer token.
   * 1. If an explicit token was passed in authOpts, use it.
   * 2. For Docker Hub: call the auth server with optional username/password.
   * 3. For private registries: issue a challenge request (GET /v2/) to discover
   *    the auth endpoint, then authenticate.
   */
  async authenticate(scope) {
    // Explicit token wins
    if (this.authOpts.token) {
      this._token = this.authOpts.token;
      return;
    }

    if (this.isDockerHub) {
      await this._dockerHubAuth(scope);
    } else {
      await this._bearerChallenge(scope);
    }
  }

  async _dockerHubAuth(scope) {
    const username = this.authOpts.username || process.env.DOCKER_USERNAME;
    const password = this.authOpts.password || process.env.DOCKER_PASSWORD;

    const params = new URLSearchParams({
      service: 'registry.docker.io',
      scope:   scope || `repository:${this.repo}:pull`,
    });

    const config = { params };
    if (username && password) {
      config.auth = { username, password };
    }

    const res = await axios.get('https://auth.docker.io/token', config);
    this._token       = res.data.token || res.data.access_token;
    // token TTL in seconds (default 300)
    const expiresIn   = res.data.expires_in || 300;
    this._tokenExpiry = Date.now() + (expiresIn - 10) * 1000;
  }

  async _bearerChallenge(scope) {
    // Step 1: Probe /v2/ to get the WWW-Authenticate header
    let wwwAuth;
    try {
      await axios.get(`${this.baseUrl}/`, { validateStatus: s => s < 500 });
    } catch (err) {
      if (err.response && err.response.status === 401) {
        wwwAuth = err.response.headers['www-authenticate'];
      } else {
        throw err;
      }
    }

    if (!wwwAuth) {
      // Try HTTP Basic directly (simple private registries)
      this._useBasic = true;
      return;
    }

    // Parse:  Bearer realm="https://...",service="...",scope="..."
    const realm   = (wwwAuth.match(/realm="([^"]+)"/)   || [])[1];
    const service = (wwwAuth.match(/service="([^"]+)"/) || [])[1];
    if (!realm) { this._useBasic = true; return; }

    const params = new URLSearchParams();
    if (service) params.set('service', service);
    params.set('scope', scope || `repository:${this.repo}:pull`);

    const config = { params };
    const username = this.authOpts.username || process.env.DOCKER_USERNAME;
    const password = this.authOpts.password || process.env.DOCKER_PASSWORD;
    if (username && password) config.auth = { username, password };

    const res = await axios.get(realm, config);
    this._token       = res.data.token || res.data.access_token;
    const expiresIn   = res.data.expires_in || 300;
    this._tokenExpiry = Date.now() + (expiresIn - 10) * 1000;
  }

  /** Returns the Authorization header value for a request. */
  async _authHeader(scope) {
    // Re-authenticate if the token has expired
    if (!this._token || Date.now() >= this._tokenExpiry) {
      await this.authenticate(scope);
    }
    if (this._useBasic) {
      const username = this.authOpts.username || process.env.DOCKER_USERNAME || '';
      const password = this.authOpts.password || process.env.DOCKER_PASSWORD || '';
      return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    return `Bearer ${this._token}`;
  }

  // ── Manifest ────────────────────────────────────────────────────────────────

  /**
   * Fetch and resolve the manifest for this image.
   * Automatically picks the correct platform from a manifest list.
   * Returns the concrete image manifest (not a list).
   */
  async resolveManifest(wantArch, wantOS) {
    wantArch = wantArch || ARCH_MAP[process.arch] || 'amd64';
    wantOS   = wantOS   || (process.platform === 'win32' ? 'windows' : 'linux');
    return this._fetchManifest(this.tag, wantArch, wantOS);
  }

  async _fetchManifest(ref, wantArch, wantOS) {
    const url  = `${this.baseUrl}/${this.repo}/manifests/${ref}`;
    const auth = await this._authHeader(`repository:${this.repo}:pull`);

    const res = await axios.get(url, {
      headers: {
        Authorization: auth,
        Accept: [
          MT.MANIFEST_LIST, MT.MANIFEST_OCI_IDX,
          MT.MANIFEST_V2,   MT.MANIFEST_OCI,
          MT.MANIFEST_V1,
        ].join(', '),
      },
      validateStatus: null,
    });

    if (res.status === 401) {
      // Token expired mid-session; re-auth once and retry
      this._token = null;
      const auth2 = await this._authHeader(`repository:${this.repo}:pull`);
      return this._fetchManifest(ref, wantArch, wantOS);
    }

    if (res.status !== 200) {
      throw new Error(
        `Registry returned HTTP ${res.status} for manifest ${this.repo}:${ref}\n` +
        `  ${JSON.stringify(res.data).slice(0, 200)}`
      );
    }

    const ct   = (res.headers['content-type'] || '').split(';')[0].trim();
    const data = res.data;

    // Manifest list / OCI index → pick correct platform
    if (ct === MT.MANIFEST_LIST || ct === MT.MANIFEST_OCI_IDX ||
        (data.manifests && Array.isArray(data.manifests))) {
      const entry =
        data.manifests.find(m => m.platform?.architecture === wantArch && m.platform?.os === wantOS) ||
        data.manifests.find(m => m.platform?.architecture === wantArch) ||
        data.manifests.find(m => m.platform?.architecture === 'amd64'  && m.platform?.os === 'linux') ||
        data.manifests[0];

      if (!entry) {
        throw new Error(
          `No matching platform (${wantOS}/${wantArch}) in manifest list for ` +
          `${this.repo}:${ref}.\n` +
          `Available: ${data.manifests.map(m => `${m.platform?.os}/${m.platform?.architecture}`).join(', ')}`
        );
      }

      return { manifest: await this._fetchManifest(entry.digest, wantArch, wantOS), selectedEntry: entry };
    }

    return { manifest: data, selectedEntry: null };
  }

  // ── Blobs ───────────────────────────────────────────────────────────────────

  /**
   * Fetch a blob as JSON (used for image config).
   */
  async fetchConfig(digest) {
    const url  = `${this.baseUrl}/${this.repo}/blobs/${digest}`;
    const auth = await this._authHeader(`repository:${this.repo}:pull`);
    const res  = await axios.get(url, {
      headers:        { Authorization: auth },
      responseType:   'json',
      validateStatus: null,
    });
    if (res.status !== 200) {
      throw new Error(`Failed to fetch config blob ${digest}: HTTP ${res.status}`);
    }
    return res.data;
  }

  /**
   * Download a blob (layer) to disk with:
   *   - Byte-level progress callback
   *   - Resume support (send Range header if a partial file exists)
   *   - HTTP error detection before writing
   *   - Validates Content-Length on completion
   *
   * @param {string}   digest      sha256:abc...
   * @param {string}   destPath    Local file path to write to
   * @param {Function} onProgress  (downloaded, total) → void
   */
  async downloadBlob(digest, destPath, onProgress) {
    const url  = `${this.baseUrl}/${this.repo}/blobs/${digest}`;
    const auth = await this._authHeader(`repository:${this.repo}:pull`);

    // Check if a partial download exists (resume support)
    let startByte = 0;
    if (fs.existsSync(destPath)) {
      startByte = fs.statSync(destPath).size;
    }

    const headers = { Authorization: auth };
    if (startByte > 0) {
      headers['Range'] = `bytes=${startByte}-`;
    }

    const res = await axios.get(url, {
      headers,
      responseType:   'stream',
      validateStatus: null,
      maxRedirects:   5,
    });

    // Handle redirects / blob redirects (Docker Hub redirects to S3)
    if (res.status === 206 && startByte === 0) {
      // Unexpected partial — treat as full
      startByte = 0;
    }

    if (res.status !== 200 && res.status !== 206) {
      // Drain and discard the error body, then throw
      res.data.resume();
      throw new Error(
        `Layer download failed: HTTP ${res.status} for ${digest.slice(0, 19)}\n` +
        `  URL: ${url}`
      );
    }

    const isResume        = res.status === 206;
    const contentLength   = parseInt(res.headers['content-length'] || '0', 10);
    const total           = isResume ? startByte + contentLength : contentLength;

    let downloaded = isResume ? startByte : 0;

    await new Promise((resolve, reject) => {
      const flag   = isResume ? 'a' : 'w';
      const writer = fs.createWriteStream(destPath, { flags: flag });

      res.data.on('data', chunk => {
        downloaded += chunk.length;
        if (onProgress) onProgress(downloaded, total || downloaded);
      });

      res.data.on('error', reject);
      writer.on('error',   reject);
      writer.on('finish',  resolve);
      res.data.pipe(writer);
    });

    // Integrity check: Content-Length vs actual written bytes
    if (contentLength > 0) {
      const written = fs.statSync(destPath).size;
      if (written !== total) {
        throw new Error(
          `Layer ${digest.slice(7, 19)} size mismatch: ` +
          `expected ${total} bytes, got ${written} bytes`
        );
      }
    }
  }

  /**
   * Check whether a blob already exists in the registry (HEAD request).
   * Used to verify digest before skipping a download.
   */
  async blobExists(digest) {
    const url  = `${this.baseUrl}/${this.repo}/blobs/${digest}`;
    const auth = await this._authHeader(`repository:${this.repo}:pull`);
    try {
      const res = await axios.head(url, {
        headers:        { Authorization: auth },
        validateStatus: null,
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}

module.exports = { RegistryClient, parseRef, MT, ARCH_MAP };
