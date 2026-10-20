'use strict';
/**
 * Persistent state store for containers and images.
 *
 * Data is kept in JSON files inside ~/.minicontainer/:
 *   containers.json  — map of containerId → ContainerRecord
 *   images.json      — map of imageRef → ImageRecord
 *
 * All writes are atomic (write-to-temp then rename).
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs-extra');
const eventlog = require('./eventlog');
const { getConfig } = require('./tenant');

const CONFIG = getConfig();
const ROOT        = CONFIG.root;
const IMAGES_DIR  = CONFIG.imagesDir;
const CONTAINERS_DIR = CONFIG.containersDir;
const CONTAINERS_DB  = CONFIG.containersDb;
const IMAGES_DB      = CONFIG.imagesDb;

// Ensure directories exist on first import
fs.ensureDirSync(ROOT);
fs.ensureDirSync(IMAGES_DIR);
fs.ensureDirSync(CONTAINERS_DIR);

// ---------- low-level read/write ----------

function readDB(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeDB(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- containers ----------

function getContainers() {
  return readDB(CONTAINERS_DB);
}

function getContainer(idOrName) {
  const db = getContainers();
  // exact id match
  if (db[idOrName]) return db[idOrName];
  // prefix match on id
  const prefixMatch = Object.values(db).find(c => c.id.startsWith(idOrName));
  if (prefixMatch) return prefixMatch;
  // name match
  return Object.values(db).find(c => c.name === idOrName) || null;
}

function saveContainer(record) {
  const prev = getContainers()[record.id];
  const db   = getContainers();
  db[record.id] = record;
  writeDB(CONTAINERS_DB, db);

  // Emit state-change events only on meaningful transitions
  const prevStatus = prev?.status;
  const newStatus  = record.status;
  if (!prev) {
    eventlog.container.create(record.id, record.name, record.image);
  } else if (prevStatus !== newStatus) {
    if (newStatus === 'running') {
      eventlog.container.start(record.id, record.name, record.pid);
    } else if (newStatus === 'exited') {
      if (prevStatus === 'running') eventlog.container.stop(record.id, record.name);
      eventlog.container.die(record.id, record.name, record.exitCode);
    }
  }
}

function deleteContainer(idOrName) {
  const c = getContainer(idOrName);
  if (!c) throw new Error(`No such container: ${idOrName}`);
  const db = getContainers();
  delete db[c.id];
  writeDB(CONTAINERS_DB, db);
  eventlog.container.destroy(c.id, c.name);
  return c;
}

// ---------- images ----------

function getImages() {
  return readDB(IMAGES_DB);
}

function getImage(ref) {
  const db = getImages();
  return db[normaliseRef(ref)] || null;
}

function saveImage(record) {
  const db  = getImages();
  const key = normaliseRef(record.ref);
  const isNew = !db[key];
  db[key] = record;
  writeDB(IMAGES_DB, db);
  if (isNew) {
    // Determine how the image arrived: pull vs build vs load
    const action = record._loadedFrom ? 'load'
                 : record._builtFrom  ? 'build'
                 : 'pull';
    eventlog.emit('image', action, { id: record.ref, name: record.ref,
      attrs: { digest: record.digest || '', tag: record.ref } });
  }
}

function deleteImage(ref) {
  const db  = getImages();
  const key = normaliseRef(ref);
  if (!db[key]) throw new Error(`No such image: ${ref}`);
  delete db[key];
  writeDB(IMAGES_DB, db);
  eventlog.image.delete(ref);
}

// Adds ":latest" if no tag present
function normaliseRef(ref) {
  return ref.includes(':') ? ref : `${ref}:latest`;
}

// ---------- paths ----------

function containerDir(id) {
  return path.join(CONTAINERS_DIR, id);
}

function imageDir(id) {
  return path.join(IMAGES_DIR, id);
}

module.exports = {
  ROOT,
  TENANT: CONFIG.tenant,
  IMAGES_DIR,
  CONTAINERS_DIR,
  getContainers,
  getContainer,
  saveContainer,
  deleteContainer,
  getImages,
  getImage,
  saveImage,
  deleteImage,
  normaliseRef,
  containerDir,
  imageDir,
};
