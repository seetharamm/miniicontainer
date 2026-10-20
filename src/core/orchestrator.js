'use strict';

const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const store = require('../state/store');
const { runContainer } = require('./runtime');

const ORCHESTRATOR_DB = path.join(store.ROOT, 'orchestrator.json');

function services(state) {
  state.services = state.services || {};
  return state.services;
}

function readState() {
  if (!fs.existsSync(ORCHESTRATOR_DB)) return { nodes: {}, workloads: {} };
  try { return { nodes: {}, workloads: {}, ...JSON.parse(fs.readFileSync(ORCHESTRATOR_DB, 'utf8')) }; }
  catch { return { nodes: {}, workloads: {} }; }
}

function writeState(state) {
  const tmp = ORCHESTRATOR_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, ORCHESTRATOR_DB);
}

function registerNode(node) {
  if (!node || !node.id || !node.endpoint) throw new Error('Node id and endpoint are required');
  const state = readState();
  state.nodes[node.id] = {
    id: node.id,
    endpoint: node.endpoint.replace(/\/$/, ''),
    capacity: Number(node.capacity || 1),
    labels: node.labels || {},
    token: node.token || null,
    status: 'ready',
    lastHeartbeat: null,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.nodes[node.id];
}

function listNodes() { return Object.values(readState().nodes); }
function getState() { return readState(); }

function chooseNode(nodes, requirement = {}) {
  const candidates = nodes.filter(n => n.status === 'ready' &&
    Object.entries(requirement.labels || {}).every(([k, v]) => n.labels?.[k] === v));
  if (!candidates.length) throw new Error('No eligible orchestrator node is available');
  return candidates.sort((a, b) => {
    const ar = (a.running || 0) / Math.max(a.capacity, 1);
    const br = (b.running || 0) / Math.max(b.capacity, 1);
    return ar - br;
  })[0];
}

async function deployToNode(state, workload, node) {
  const payload = { ...workload, name: workload.name || workload.id, detach: true };
  const headers = node.token ? { Authorization: `Bearer ${node.token}` } : {};
  const result = await axios.post(`${node.endpoint}/v1/run`, payload, { headers, timeout: 5000 });
  node.running = (node.running || 0) + 1;
  node.updatedAt = new Date().toISOString();
  state.workloads[workload.id] = { ...workload, nodeId: node.id, status: 'running', container: result.data };
  if (workload.service && workload.servicePort) {
    services(state)[workload.service] = {
      name: workload.service,
      nodeId: node.id,
      containerId: result.data.id,
      port: Number(workload.servicePort),
      protocol: workload.protocol || 'http',
      updatedAt: new Date().toISOString(),
    };
  }
  writeState(state);
  return state.workloads[workload.id];
}

async function deploy(workload) {
  if (!workload?.id || !workload.image) throw new Error('Workload id and image are required');
  const state = readState();
  const node = chooseNode(Object.values(state.nodes), workload);
  return deployToNode(state, workload, node);
}

async function heartbeatNode(nodeId) {
  const state = readState();
  const node = state.nodes[nodeId];
  if (!node) throw new Error(`No such orchestrator node: ${nodeId}`);
  const headers = node.token ? { Authorization: `Bearer ${node.token}` } : {};
  try {
    const result = await axios.get(`${node.endpoint}/health`, { headers, timeout: 3000 });
    if (result.data?.status !== 'ready') throw new Error('agent is not ready');
    node.status = 'ready';
    node.lastHeartbeat = new Date().toISOString();
    node.updatedAt = node.lastHeartbeat;
    writeState(state);
    return true;
  } catch (err) {
    node.lastError = err.message;
    node.updatedAt = new Date().toISOString();
    writeState(state);
    return false;
  }
}

async function failoverNode(nodeId) {
  const state = readState();
  const failed = state.nodes[nodeId];
  if (!failed) throw new Error(`No such orchestrator node: ${nodeId}`);
  failed.status = 'offline';
  failed.updatedAt = new Date().toISOString();

  const moved = [];
  for (const workload of Object.values(state.workloads)) {
    if (workload.nodeId !== nodeId || workload.status !== 'running') continue;
    const replacement = chooseNode(Object.values(state.nodes), workload);
    workload.status = 'rescheduling';
    writeState(state);
    try {
      await deployToNode(state, workload, replacement);
      workload.failovers = (workload.failovers || 0) + 1;
      moved.push({ id: workload.id, from: nodeId, to: replacement.id });
    } catch (err) {
      workload.status = 'failed';
      workload.lastError = `Failover failed: ${err.message}`;
      writeState(state);
    }
  }
  writeState(state);
  return moved;
}

function startHeartbeatMonitor({ intervalMs = 5000, failureThreshold = 2 } = {}) {
  const failures = new Map();
  const check = async () => {
    const nodes = listNodes();
    await Promise.all(nodes.map(async node => {
      if (await heartbeatNode(node.id)) {
        failures.delete(node.id);
        return;
      }
      const count = (failures.get(node.id) || 0) + 1;
      failures.set(node.id, count);
      if (count >= failureThreshold && node.status !== 'offline') {
        await failoverNode(node.id).catch(() => {});
      }
    }));
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  check();
  return { timer, stop: () => clearInterval(timer), check };
}

function registerService(name, route) {
  if (!name || !route?.nodeId || !route.port) throw new Error('Service name, nodeId, and port are required');
  const state = readState();
  services(state)[name] = { name, ...route, port: Number(route.port), updatedAt: new Date().toISOString() };
  writeState(state);
  return services(state)[name];
}

function discoverService(name) {
  return services(readState())[name] || null;
}

async function proxyService(name, request = {}) {
  const route = discoverService(name);
  if (!route) throw new Error(`No such service: ${name}`);
  const state = readState();
  const node = state.nodes[route.nodeId];
  if (!node || node.status !== 'ready') throw new Error(`Service node is unavailable: ${route.nodeId}`);
  const headers = node.token ? { Authorization: `Bearer ${node.token}` } : {};
  const pathName = request.path || '/';
  const result = await axios({
    method: request.method || 'GET',
    url: `${node.endpoint}/mesh/proxy/${encodeURIComponent(name)}${pathName}`,
    headers: { ...headers, ...(request.headers || {}) },
    data: request.data,
    responseType: 'arraybuffer',
    timeout: request.timeout || 5000,
    validateStatus: () => true,
  });
  return { status: result.status, headers: result.headers, data: result.data };
}

function createAgentServer({ host = '0.0.0.0', port = 8787, token = null } = {}) {
  const authorized = req => !token || req.headers.authorization === `Bearer ${token}`;
  const body = req => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
  const reply = (res, code, value) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return reply(res, 200, { status: 'ready', node: process.env.MINICONTAINER_NODE_ID || null, time: new Date().toISOString() });
      }
      if (req.method === 'POST' && req.url === '/v1/run') {
        const workload = await body(req);
        const result = await runContainer(workload);
        if (workload.service && workload.servicePort) {
          registerService(workload.service, {
            nodeId: process.env.MINICONTAINER_NODE_ID || 'local',
            containerId: result.id,
            port: workload.servicePort,
            protocol: workload.protocol || 'http',
          });
        }
        return reply(res, 201, result);
      }
      if (req.method === 'GET' && req.url === '/v1/containers') return reply(res, 200, store.getContainers());
      if (req.method === 'GET' && req.url === '/mesh/services') {
        return reply(res, 200, services(readState()));
      }
      if (req.url.startsWith('/mesh/proxy/')) {
        const parts = req.url.split('/');
        const service = decodeURIComponent(parts[3]);
        const route = services(readState())[service];
        if (!route) return reply(res, 404, { error: `No such service: ${service}` });
        const target = store.getContainer(route.containerId);
        if (!target?.ip) return reply(res, 503, { error: 'Service container has no network address' });
        const targetPath = '/' + parts.slice(4).join('/').split('?')[0];
        const result = await axios({
          method: req.method,
          url: `http://${target.ip}:${route.port}${targetPath || '/'}`,
          headers: req.headers,
          data: await body(req),
          responseType: 'arraybuffer',
          timeout: 5000,
          validateStatus: () => true,
        });
        res.writeHead(result.status, { 'content-type': result.headers['content-type'] || 'application/octet-stream' });
        return res.end(result.data);
      }
      reply(res, 404, { error: 'not found' });
    } catch (err) { reply(res, 400, { error: err.message }); }
  });
  return server;
}

module.exports = {
  registerNode, listNodes, getState, chooseNode, deploy, heartbeatNode,
  failoverNode, startHeartbeatMonitor, registerService, discoverService,
  proxyService, createAgentServer, ORCHESTRATOR_DB,
};
