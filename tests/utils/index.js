const _ = require('lodash');
const constants = require('@constants');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn, exec } = require('child_process');
const mustache = require('mustache');
// by default, mustache escapes slashes, which messes with paths and urls.
mustache.escape = (text) => text;
const moment = require('moment');
const commonElements = require('@page-objects/default/common/common.wdio.page');
const userSettings = require('@factories/cht/users/user-settings');
const buildVersions = require('../../scripts/build/versions');
const PouchDB = require('pouchdb-core');
const chtDbUtils = require('@utils/cht-db');
PouchDB.plugin(require('pouchdb-adapter-http'));
PouchDB.plugin(require('pouchdb-mapreduce'));
const { setTimeout: setTimeoutPromise } = require('node:timers/promises');

process.env.COUCHDB_USER = constants.USERNAME;
process.env.COUCHDB_PASSWORD = constants.PASSWORD;
process.env.CERTIFICATE_MODE = constants.CERTIFICATE_MODE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0; // allow self signed certificates
const DEBUG = process.env.DEBUG;

let originalSettings;
let infrastructure = 'docker';
const isDocker = () => infrastructure === 'docker';
const isK3D = () => !isDocker();
const K3D_DATA_PATH = '/data';
const K3D_REGISTRY = 'registry.localhost';
let K3D_REGISTRY_PORT;
const K3D_REPO = () => `k3d-${K3D_REGISTRY}:${K3D_REGISTRY_PORT}`;

const auth = { username: constants.USERNAME, password: constants.PASSWORD };
const SW_SUCCESSFUL_REGEX = /Service worker generated successfully/;
const ONE_YEAR_IN_S = 31536000;
const PROJECT_NAME = 'cht-e2e';
const NETWORK = 'cht-net-e2e';
const SERVICES = {
  haproxy: 'haproxy',
  nginx: 'nginx',
  couchdb1: 'couchdb-1.local',
  couchdb2: 'couchdb-2.local',
  couchdb3: 'couchdb-3.local',
  api: 'api',
  sentinel: 'sentinel',
  'haproxy-healthcheck': 'healthcheck',
};
const CONTAINER_NAMES = {};
const originalTranslations = {};
const COUCH_USER_ID_PREFIX = 'org.couchdb.user:';
const COMPOSE_FILES = ['cht-core', 'cht-couchdb-cluster'];
const PERMANENT_TYPES = ['translations', 'translations-backup', 'user-settings', 'info'];
const db = new PouchDB(`${constants.BASE_URL}/${constants.DB_NAME}`, { auth });
const sentinelDb = new PouchDB(`${constants.BASE_URL}/${constants.DB_NAME}-sentinel`, { auth });
const usersDb = new PouchDB(`${constants.BASE_URL}/_users`, { auth });
const logsDb = new PouchDB(`${constants.BASE_URL}/${constants.DB_NAME}-logs`, { auth });
const auditDb = new PouchDB(`${constants.BASE_URL}/${constants.DB_NAME}-audit`, { auth });
const existingFeedbackDocIds = [];
const MINIMUM_BROWSER_VERSION = '90';
const KUBECTL_CONTEXT = `-n ${PROJECT_NAME} --context k3d-${PROJECT_NAME}`;

const makeTempDir = (prefix) => fs.mkdtempSync(path.join(path.join(os.tmpdir(), prefix || 'ci-')));
const env = {
  ...process.env,
  CHT_NETWORK: NETWORK,
  COUCHDB_SECRET: 'monkey',
  COUCHDB_UUID: 'the_uuid',
};

const dockerPlatformName = () => {
  try {
    return JSON.parse(execSync(`docker version --format '{{json .Server.Platform.Name}}'`).toString());
  } catch (error) {
    console.log('docker version failed. NOTE this error is not relevant if running outside of docker');
    console.log(error.message);
  }
  return null;
};

const isDockerDesktop = () => {
  return (dockerPlatformName() || '').includes('Docker Desktop');
};

const dockerGateway = () => {
  const network = isDocker() ? NETWORK : `k3d-${PROJECT_NAME}`;
  try {
    return JSON.parse(execSync(`docker network inspect ${network} --format='{{json .IPAM.Config}}'`).toString());
  } catch (error) {
    console.log('docker network inspect failed. NOTE this error is not relevant if running outside of docker');
    console.log(error.message);
  }
};

const getHostRoot = () => {
  if (isDockerDesktop()) {
    // Docker Desktop networking requires a special host name for connecting to host machine.
    // https://docs.docker.com/desktop/networking/#i-want-to-connect-from-a-container-to-a-service-on-the-host
    return 'host.docker.internal';
  }
  const gateway = dockerGateway();
  return gateway?.[0]?.Gateway || 'localhost';
};

const hostURL = (port = 80) => {
  const url = new URL(`http://${getHostRoot()}`);
  url.port = port;
  return url.href;
};

const parseCookieResponse = (cookieString) => {
  return cookieString.map((cookie) => {
    const cookieObject = {};
    const cookieSplit = cookie.split(';');
    const [cookieName, cookieValue] = cookieSplit.shift().split('=');
    cookieObject.name = cookieName;
    cookieObject.value = cookieValue;
    cookieSplit.forEach((cookieValues) => {
      const [key, value] = cookieValues.split('=');
      cookieObject[key] = (key.includes('Secure') || key.includes('HttpOnly')) ? true : value;
    });
    return cookieObject;
  });
};

const setupUserDoc = (userName = constants.USERNAME, userDoc = userSettings.build()) => {
  return getDoc(COUCH_USER_ID_PREFIX + userName)
    .then(doc => {
      const finalDoc = Object.assign(doc, userDoc);
      return saveDoc(finalDoc);
    });
};

const randomIp = () => {
  const section = () => (Math.floor(Math.random() * 255) + 1);
  return `${section()}.${section()}.${section()}.${section()}`;
};

const getRequestUri = (options) => {
  let uri = (options.uri || `${constants.BASE_URL}${options.path}`);
  if (options.qs) {
    Object.keys(options.qs).forEach((key) => {
      if (Array.isArray(options.qs[key])) {
        options.qs[key] = JSON.stringify(options.qs[key]);
      }
    });
    uri = `${uri}?${new URLSearchParams(options.qs).toString()}`;
  }

  return uri;
};

const setRequestContentType = (options) => {
  let sendJson = true;
  if (options.json === false ||
      (options.headers['Content-Type'] && options.headers['Content-Type'] !== 'application/json')
  ) {
    sendJson = false;
  }

  if (sendJson) {
    options.headers.Accept = 'application/json';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  return sendJson;
};

const setRequestEncoding = (options) => {
  if (options.gzip) {
    options.headers['Accept-Encoding'] = 'gzip';
  }

  if (options.gzip === false && !options.headers['Accept-Encoding']) {
    options.headers['Accept-Encoding'] = 'identity';
  }
};

const setRequestAuth = (options) => {
  if (options.noAuth) {
    return;
  }

  const auth = options.auth || { username: constants.USERNAME, password: constants.PASSWORD };
  const basicAuth = btoa(`${auth.username}:${auth.password}`);
  options.headers.Authorization = `Basic ${basicAuth}`;
};

const getRequestOptions = (options) => {
  options = typeof options === 'string' ? { path: options } : _.clone(options);
  options.headers = options.headers || {};
  options.headers['X-Forwarded-For'] = randomIp();

  const uri = getRequestUri(options);
  const sendJson = setRequestContentType(options);

  setRequestAuth(options);
  setRequestEncoding(options);

  return { uri, options, resolveWithFullResponse: options.resolveWithFullResponse, sendJson };
};

const getResponseBody = async (response, sendJson) => {
  const receiveJson =  (!response.headers.get('content-type') && sendJson) ||
                       response.headers.get('content-type')?.startsWith('application/json');
  return receiveJson ? await response.json() : await response.text();
};

// First Object is passed to http.request, second is for specific options / flags
// for this wrapper
const request = async (options, { debug } = {}) => {
  const  { uri, options: requestInit, resolveWithFullResponse, sendJson } = getRequestOptions(options);
  if (debug) {
    console.debug('SENDING REQUEST', JSON.stringify({ ...options, uri, body: null }, null, 2));
  }

  const response = await fetch(uri, requestInit);
  const responseObj = {
    ...response,
    body: await getResponseBody(response, sendJson),
    status: response.status,
    ok: response.ok,
    headers: response.headers
  };

  if (debug) {
    console.debug('RESPONSE', response.status, response.body);
  }

  if (resolveWithFullResponse) {
    return responseObj;
  }

  if (response.ok || (response.status > 300 && response.status < 399)) {
    return responseObj.body;
  }

  console.warn(`Error with request: ${options.method || 'GET'} ${uri} ${responseObj.status}`);
  const err = new Error(response.error || `${response.status} - ${JSON.stringify(responseObj.body)}`);
  Object.assign(err, responseObj);
  throw err;
};

const requestOnTestDb = (options, debug) => {
  if (typeof options === 'string') {
    options = {
      path: options,
    };
  }
  const pathAndReqType = `${options.path}${options.method}`;
  if (pathAndReqType !== '/GET') {
    options.path = '/' + constants.DB_NAME + (options.path || '');
  }
  return request(options, debug);
};

const requestOnTestMetaDb = (options, debug) => {
  if (typeof options === 'string') {
    options = {
      path: options,
    };
  }
  options.path = `/${constants.DB_NAME}-user-${options.userName}-meta${options.path || ''}`;
  return request(options, debug);
};

const requestOnMedicDb = (options, debug) => {
  if (typeof options === 'string') {
    options = { path: options };
  }
  options.path = `/medic${options.path || ''}`;
  return request(options, debug);
};

const formDocProcessing = async (docs) => {
  if (!Array.isArray(docs)) {
    docs = [docs];
  }

  const formsWatchers = docs
    .filter(doc => doc.type === 'form')
    .map(doc => new RegExp(`Form with ID "${doc._id}" does not need to be updated`))
    .map(re => waitForApiLogs(re));

  const waitForForms = await Promise.all(formsWatchers);

  return {
    promise: () => Promise.all(waitForForms.map(wait => wait.promise)),
    cancel: () => waitForForms.forEach(wait => wait.cancel),
  };
};

const saveDoc = async doc => {
  const waitForForms = await formDocProcessing(doc);
  try {
    const result = requestOnTestDb({
      path: '/', // so audit picks this up
      method: 'POST',
      body: doc,
    });
    await waitForForms.promise();
    return result;
  } catch (err) {
    waitForForms.cancel();
    throw err;
  }
};

const saveDocs = async (docs) => {
  const waitForForms = await formDocProcessing(docs);
  const results = await requestOnTestDb({
    path: '/_bulk_docs',
    method: 'POST',
    body: { docs }
  });
  if (results.find(r => !r.ok)) {
    waitForForms.cancel();
    throw Error(JSON.stringify(results, null, 2));
  }

  await waitForForms.promise();
  return results;
};

const saveDocsRevs = async (docs) => {
  const results = await saveDocs(docs);
  results.forEach(({ rev }, idx) => docs[idx]._rev = rev);
  return results;
};

const saveDocIfNotExists = async doc => {
  try {
    await getDoc(doc._id);
  } catch {
    await saveDoc(doc);
  }
};

const saveMetaDocs = (user, docs) => {
  const options = {
    userName: user,
    method: 'POST',
    body: { docs: docs },
    path: '/_bulk_docs',
  };
  return requestOnTestMetaDb(options)
    .then(results => {
      if (results.find(r => !r.ok)) {
        throw Error(JSON.stringify(results, null, 2));
      }
      return results;
    });
};

const getDoc = (id, rev = '', parameters = '') => {
  const params = {};
  if (rev) {
    params.rev = rev;
  }

  return requestOnTestDb({
    path: `/${id}${parameters}`,
    method: 'GET',
    params,
  });
};

const getDocs = (ids, fullResponse = false) => {
  return requestOnTestDb({
    path: `/_all_docs?include_docs=true`,
    method: 'POST',
    body: { keys: ids || [] },
  })
    .then(response => {
      return fullResponse ? response : response.rows.map(row => row.doc);
    });
};

const getMetaDocs = (user, ids, fullResponse = false) => {
  const options = {
    userName: user,
    method: 'POST',
    body: { keys: ids || [] },
    path: '/_all_docs?include_docs=true',
  };
  return requestOnTestMetaDb(options)
    .then(response => fullResponse ? response : response.rows.map(row => row.doc));
};

const deleteDoc = id => {
  return getDoc(id).then(doc => {
    doc._deleted = true;
    return saveDoc(doc);
  });
};

const deleteDocs = ids => {
  return getDocs(ids).then(docs => {
    docs = docs.filter(doc => !!doc);
    if (docs.length) {
      docs.forEach(doc => doc._deleted = true);
      return requestOnTestDb({
        path: '/_bulk_docs',
        method: 'POST',
        body: { docs },
      });
    }
  });
};

const PROTECTED_DOCS = [
  'service-worker-meta',
  constants.USER_CONTACT_ID,
  'migration-log',
  'resources',
  'branding',
  'partners',
  'settings',
  /^form:/,
  /^_design/
];

const createDocumentFilters = (excludeList) => {
  const filters = {
    functions: [],
    strings: [],
    patterns: []
  };

  filters.functions.push(doc => PERMANENT_TYPES.includes(doc.type));

  [...PROTECTED_DOCS, ...(Array.isArray(excludeList) ? excludeList : [])]
    .forEach(item => {
      if (typeof item === 'function') {
        filters.functions.push(item);
      } else if (item instanceof RegExp) {
        filters.patterns.push(item);
      } else {
        filters.strings.push(item);
      }
    });

  return filters;
};

const shouldDocumentBeKept = (doc, filters) => {
  return filters.functions.some(fn => fn(doc)) ||
         filters.strings.includes(doc._id) ||
         filters.patterns.some(pattern => doc._id.match(pattern));
};

const deleteSentinelDocs = async (docsToKeep) => {
  const allDocs = await sentinelDb.allDocs({ include_docs: true });
  const sentinelDocsToDelete = allDocs.rows
    .filter(row => row.value)
    .filter(({ id }) => !docsToKeep.includes(id.replace(/-info$/, '')) && !id.startsWith('_design'))
    .map(({ id, value }) => ({
      _id: id,
      _rev: value.rev,
      _deleted: true
    }));

  const response = await sentinelDb.bulkDocs(sentinelDocsToDelete);
  if (DEBUG) {
    console.log(`Deleted sentinel docs: ${JSON.stringify(response)}`);
  }
  await require('@utils/sentinel').skipToSeq();
};

/**
 * Deletes all docs in the database, except some core docs (read the code) and
 * any docs that you specify.
 *
 * NB: this is back-end only, it does *not* care about the front-end, and will
 * not detect if it needs to refresh
 *
 * @param      {Array}    except  array of: exact document name; or regex; or
 *                                predicate function that returns true if you
 *                                wish to keep the document
 * @return     {Promise}  completion promise
 */
const deleteAllDocs = async (except = []) => {
  const filters = createDocumentFilters(except);
  const { rows } = await db.allDocs({ include_docs: true });

  const docsToDelete = rows
    .filter(({ doc }) => doc && !shouldDocumentBeKept(doc, filters))
    .map(({ doc }) => ({
      _id: doc._id,
      _rev: doc._rev,
      _deleted: true
    }));
  const docsToKeep = rows
    .filter(({ doc }) => doc && shouldDocumentBeKept(doc, filters))
    .map(({ doc }) => doc._id);

  if (DEBUG) {
    console.log(`Deleting docs and infodocs: ${docsToDelete.map(doc => doc._id)}`);
  }

  const response = await db.bulkDocs(docsToDelete);
  if (DEBUG) {
    console.log(`Deleted docs: ${JSON.stringify(response)}`);
  }
  await deleteSentinelDocs(docsToKeep);
};


// Update both ddocs, to avoid instability in tests.
// Note that API will be copying changes to medic over to medic-client, so change
// medic-client first (api does nothing) and medic after (api copies changes over to
// medic-client, but the changes are already there.)
const updateCustomSettings = updates => {
  if (originalSettings) {
    throw new Error('A previous test did not call revertSettings');
  }
  return request({
    path: '/api/v1/settings',
    method: 'GET',
  })
    .then(settings => {
      originalSettings = settings;
      // Make sure all updated fields are present in originalSettings, to enable reverting later.
      Object.keys(updates).forEach(updatedField => {
        if (!_.has(originalSettings, updatedField)) {
          originalSettings[updatedField] = null;
        }
      });
    })
    .then(() => {
      return request({
        path: '/api/v1/settings?replace=1',
        method: 'PUT',
        body: updates,
      });
    });
};

const waitForSettingsUpdateLogs = (type) => {
  if (type === 'sentinel') {
    return waitForSentinelLogs(true, /Reminder messages allowed between/);
  }
  return waitForApiLogs(/Settings updated/);
};

/**
 * Update settings and refresh if required
 *
 * @param {Object}         updates  Object containing all updates you wish to
 *                                  make
 * @param  {Object} options | ignore reload: if false, will wait for reload modal and reload. if truthy, will tail
 *                                       service logs and resolve when new settings are loaded. By default, watches
 *                                       api logs, if value equals 'sentinel', will watch sentinel logs instead.
 * @return {Promise}        completion promise
 */
/**
 * Update settings and refresh if required.
 *
 * This function updates application settings based on the provided updates object and options.
 * It handles optional settings for ignoring reloads, synchronizing, refreshing the page,
 * and reverting settings to their previous state.
 *
 * @param {Object} updates - Object containing all updates you wish to make.
 *                           The keys should correspond to the settings that need to be updated,
 *                           and the values should be the new values for those settings.
 * @param {Object} [options={}] - Options to control the behavior of the update.
 * @param {boolean} [options.ignoreReload=false] - if `false`, will wait for reload modal and reload. if `truthy`,
 *                                                 will tail service logs and resolve when new settings are loaded.
 *                                                 By default, watches api logs, if value equals 'sentinel', will
 *                                                 watch sentinel logs instead.
 * @param {boolean} [options.sync=false] - If `true`, the function will perform a synchronization
 *                                         after updating the settings. Defaults to `false`.
 * @param {boolean} [options.refresh=false] - If `true`, the function will refresh the browser after
 *                                            updating the settings. Defaults to `false`.
 * @param {boolean} [options.revert=false] - If `true`, the function will revert the settings to their
 *                                           previous state before applying the new updates. Defaults to `false`.
 *
 * @return {Promise} - A promise that resolves when the settings update process is complete.
 *                     The promise may resolve after waiting for logs, reloading, synchronizing, or refreshing,
 *                     depending on the options provided.
 */
const updateSettings = async (updates, options = {}) => {
  const {ignoreReload = false, sync = false, refresh = false, revert = false} = options;
  if (revert) {
    await revertSettings(true);
  }
  const watcher = ignoreReload && Object.keys(updates).length && await waitForSettingsUpdateLogs(ignoreReload);
  await updateCustomSettings(updates);
  if (!ignoreReload && !sync) {
    return await commonElements.closeReloadModal(true);
  }
  if (watcher) {
    await watcher.promise;
  }
  if (sync) {
    await commonElements.sync({ expectReload: true });
  }
  if (refresh) {
    await browser.refresh();
  }
};

const revertCustomSettings = () => {
  if (!originalSettings) {
    return Promise.resolve(false);
  }
  return request({
    path: '/api/v1/settings?replace=1',
    method: 'PUT',
    body: originalSettings,
  }).then((result) => {
    originalSettings = null;
    return result.updated;
  });
};

/**
 * Revert settings and refresh if required
 *
 * @param {Boolean|String} ignoreRefresh if false, will wait for reload modal and reload. if true, will tail api logs
 *                                       and resolve when new settings are loaded.
 * @return {Promise}       completion promise
 */
const revertSettings = async ignoreRefresh => {
  const watcher = ignoreRefresh && await waitForSettingsUpdateLogs();
  const needsRefresh = await revertCustomSettings();

  if (!ignoreRefresh) {
    return needsRefresh && await commonElements.closeReloadModal(true);
  }

  if (!needsRefresh) {
    watcher?.cancel();
    return;
  }

  return await watcher.promise;
};

const seedTestData = (userContactDoc, documents) => {
  return saveDocs(documents)
    .then(() => getDoc(constants.USER_CONTACT_ID))
    .then(existingContactDoc => {
      if (userContactDoc) {
        Object.assign(existingContactDoc, userContactDoc);
        return saveDoc(existingContactDoc);
      }
    });
};

const revertTranslations = async () => {
  const updatedTranslations = Object.keys(originalTranslations);
  if (!updatedTranslations.length) {
    return Promise.resolve();
  }

  const docs = await getDocs(updatedTranslations.map(code => `messages-${code}`));
  docs.forEach(doc => {
    doc.generic = Object.assign(doc.generic, originalTranslations[doc.code]);
    delete originalTranslations[doc.code];
  });

  await requestOnTestDb({
    path: '/_bulk_docs',
    method: 'POST',
    body: { docs },
  });
};

const deleteLocalDocs = async () => {
  const localDocs = await requestOnTestDb({ path: '/_local_docs?include_docs=true' });

  const docsToDelete = localDocs.rows
    .filter(row => row?.doc?.replicator === 'pouchdb')
    .map(row => {
      row.doc._deleted = true;
      return row.doc;
    });

  await saveDocs(docsToDelete);
};

const hasModal = () => $('#update-available').isDisplayed();

const getDefaultForms = async () => {
  const docName = '_local/default-forms';
  try {
    const doc = await db.get(docName);
    return doc.forms;
  } catch {
    const result = await db.allDocs({ startkey: 'form:', endkey: 'form:\ufff0' });
    const doc = {
      _id: docName,
      forms: result.rows.map(row => row.id),
    };
    await db.put(doc);
    return doc.forms;
  }
};

const setUserContactDoc = (attempt = 0) => {
  const {
    USER_CONTACT_ID: docId,
    DEFAULT_USER_CONTACT_DOC: defaultDoc
  } = constants;

  return db
    .get(docId)
    .catch(() => ({}))
    .then(existing => Object.assign(defaultDoc, { _rev: existing?._rev }))
    .then(newDoc => db.put(newDoc))
    .catch(err => {
      if (attempt > 3) {
        throw err;
      }
      return setUserContactDoc(attempt + 1);
    });
};

const deleteMetaDbs = async () => {
  const allDbs = await request({ path: '/_all_dbs' });
  const metaDbs = allDbs.filter(db => db.endsWith('-meta') && !db.endsWith('-users-meta'));
  for (const metaDb of metaDbs) {
    await request({ method: 'DELETE', path: `/${metaDb}` });
  }
};

/**
 * Deletes documents from the database, including Enketo forms. Use with caution.
 * @param {array} except - exeptions in the delete method. If this parameter is empty
 *                         everything will be deleted from the config, including all the enketo forms.
 * @param {boolean} ignoreRefresh
 */
const revertDb = async (except, ignoreRefresh) => { //NOSONAR
  await deleteAllDocs(except);
  await revertTranslations();
  await deleteLocalDocs();
  const watcher = ignoreRefresh && await waitForSettingsUpdateLogs();
  const needsRefresh = await revertCustomSettings();

  // only refresh if the settings were changed or modal was already present and we're not explicitly ignoring
  if (!ignoreRefresh && (needsRefresh || await hasModal())) {
    watcher?.cancel();
    await commonElements.closeReloadModal(true);
  } else if (needsRefresh) {
    watcher && await watcher.promise;
  } else {
    watcher?.cancel();
  }

  await deleteMetaDbs();

  await setUserContactDoc();
};

const getOrigin = () => `${constants.BASE_URL}`;

const getBaseUrl = () => `${constants.BASE_URL}/#/`;

const getAdminBaseUrl = () => `${constants.BASE_URL}/admin/#/`;

const getLoggedInUser = async () => {
  try {
    if (typeof browser === 'undefined') {
      return;
    }
    const cookies = await browser.getCookies('userCtx');
    if (!cookies.length) {
      return;
    }

    const userCtx = JSON.parse(decodeURIComponent(cookies?.[0]?.value));
    return userCtx.name;
  } catch (err) {
    console.warn('Error getting userCtx', err.message);
    return;
  }
};

/**
 * Deletes _users docs and medic/user-settings docs for specified users
 * @param {Array} users - list of users to be deleted
 * @param {Boolean} meta - if true, deletes meta db-s as well, default true
 * @return {Promise}
 */
const deleteUsers = async (users, meta = false) => { //NOSONAR
  if (!users.length) {
    return;
  }

  const loggedUser = await getLoggedInUser();
  if (loggedUser && users.find(user => user.username === loggedUser)) {
    await browser.reloadSession();
  }

  const usernames = users.map(user => COUCH_USER_ID_PREFIX + user.username);
  const userDocs = await request({ path: '/_users/_all_docs', method: 'POST', body: { keys: usernames } });
  const medicDocs = await request({
    path: `/${constants.DB_NAME}/_all_docs`,
    method: 'POST',
    body: { keys: usernames }
  });

  const toDelete = userDocs.rows
    .map(row => row.value && !row.value.deleted && ({ _id: row.id, _rev: row.value.rev, _deleted: true }))
    .filter(stub => stub);
  const toDeleteMedic = medicDocs.rows
    .map(row => row.value && !row.value.deleted && ({ _id: row.id, _rev: row.value.rev, _deleted: true }))
    .filter(stub => stub);

  const results = await Promise.all([
    request({ path: '/_users/_bulk_docs', method: 'POST', body: { docs: toDelete } }),
    request({ path: `/${constants.DB_NAME}/_bulk_docs`, method: 'POST', body: { docs: toDeleteMedic } }),
  ]);
  const errors = results.flat().filter(result => !result.ok);
  if (errors.length) {
    return deleteUsers(users, meta);
  }
};

const deletePurgeDbs = async () => {
  const dbs = await request({ path: '/_all_dbs' });
  const purgeDbs = dbs.filter(db => db.includes('purged-role'));
  for (const purgeDb of purgeDbs) {
    await request({ path: `/${purgeDb}`, method: 'DELETE' });
  }
};

const getCreatedUsers = async () => {
  const adminUserId = COUCH_USER_ID_PREFIX + constants.USERNAME;
  const users = await request({ path: `/_users/_all_docs?start_key="${COUCH_USER_ID_PREFIX}"` });
  return users.rows
    .filter(user => user.id !== adminUserId)
    .map((user) => ({ ...user, username: user.id.replace(COUCH_USER_ID_PREFIX, '') }));
};

/**
 * Creates users - optionally also creating their meta dbs
 * @param {Array} users - list of users to be created
 * @param {Boolean} meta - if true, creates meta db-s as well, default false
 * @param {Boolean} password_change_required - if true, will require user to reset password on first time login
 * @return {Promise}
 * */
const createUsers = async (users, meta = false, password_change_required = false) => {
  const createUserOpts = { path: '/api/v1/users', method: 'POST' };
  const createUserV3Opts = { path: '/api/v3/users', method: 'POST' };

  for (const user of users) {
    const options = {
      body: {
        ...user,
        password_change_required: password_change_required ? undefined : false
      },
      ...(Array.isArray(user.place) ? createUserV3Opts : createUserOpts)
    };
    await request(options);
  }

  await delayPromise(1000);

  if (!meta) {
    return;
  }

  for (const user of users) {
    await request({ path: `/${constants.DB_NAME}-user-${user.username}-meta`, method: 'PUT' });
  }
};

const getAllUserSettings = () => db
  .query('medic-client/doc_by_type', { include_docs: true, key: ['user-settings'] })
  .then(response => response.rows.map(row => row.doc));

/**
 * Returns all the user settings docs matching the given criteria.
 * @param {{ name, contactId }} opts - object containing the query parameters
 * @return {Promise}
 * */
const getUserSettings = ({ contactId, name }) => {
  return getAllUserSettings()
    .then(docs => docs.filter(doc => {
      const nameMatches = !name || doc.name === name;
      const contactIdMatches = !contactId || doc.contact_id === contactId;
      return nameMatches && contactIdMatches;
    }));
};

const listenForApi = async () => {
  let retryCount = 180;
  do {
    try {
      console.log(`Checking API, retries left ${retryCount}`);
      return await request({ path: '/api/info' });
    } catch (err) {
      console.log('API check failed, trying again in 1 second');
      console.log(err.message);
      await delayPromise(1000);
    }
  } while (--retryCount > 0);
  throw new Error('API failed to start after 3 minutes');
};

const dockerComposeCmd = (params) => {
  const composeFiles = COMPOSE_FILES.map(file => ['-f', getTestComposeFilePath(file)]).flat();
  params = `docker compose ${composeFiles.join(' ')} -p ${PROJECT_NAME} ${params}`;

  return runCommand(params);
};

const sendSignal = async (service, signal) => {
  const getPIDcmd = `/bin/bash -c "pgrep -n node"`;
  const killCmd = (pid) => `/bin/bash -c "kill -s ${signal} ${pid.trim()}"`;
  if (isDocker()) {
    const pid = await dockerComposeCmd(`exec ${service} ${getPIDcmd}`);
    return await dockerComposeCmd(`exec ${service} ${killCmd(pid)}`);
  }

  const pid = await runCommand(`kubectl ${KUBECTL_CONTEXT} exec deployments/cht-${service} -- ${getPIDcmd}`);
  await runCommand(`kubectl ${KUBECTL_CONTEXT} exec deployments/cht-${service} -- ${killCmd(pid)}`);
};

const stopService = async (service) => {
  if (isDocker()) {
    return await dockerComposeCmd(`stop -t 0 ${service}`);
  }
  await saveLogs(); // we lose logs when a pod crashes or is stopped.
  await runCommand(`kubectl ${KUBECTL_CONTEXT} scale deployment cht-${service} --replicas=0`);
  let tries = 100;
  do {
    try {
      await getPodName(service, false);
      await delayPromise(100);
      tries--;
    } catch {
      return;
    }
  } while (tries > 0);
};

const waitForService = async (service) => {
  if (isDocker()) {
    // in Docker, containers start quickly enough that there is no need to check status
    return;
  }

  let tries = 100;
  do {
    try {
      const podName = await getPodName(service);
      await runCommand(
        `kubectl ${KUBECTL_CONTEXT} wait --for jsonpath={.status.containerStatuses[0].started}=true ${podName}`,
        { verbose: false }
      );
      return;
    } catch {
      tries--;
      await delayPromise(500);
    }
  } while (tries > 0);
};

const stopSentinel = () => stopService('sentinel');

const startService = async (service) => {
  if (isDocker()) {
    return await dockerComposeCmd(`start ${service}`);
  }
  await runCommand(`kubectl ${KUBECTL_CONTEXT} scale deployment cht-${service} --replicas=1`);
};

const startSentinel = async (listen) => {
  await startService('sentinel');
  listen && await waitForService('sentinel');
};

const stopApi = () => stopService('api');

const startApi = async (listen = true) => {
  await startService('api');
  listen && await listenForApi();
};

const stopHaproxy = () => stopService('haproxy');
const startHaproxy = () => startService('haproxy');

const stopCouchDb = async () => {
  await stopService('couchdb-1.local');
  await stopService('couchdb-2.local');
  await stopService('couchdb-3.local');
};
const startCouchDb = async () => {
  await startService('couchdb-1.local');
  await startService('couchdb-2.local');
  await startService('couchdb-3.local');
};

const saveCredentials = (key, password) => {
  const options = {
    path: `/api/v1/credentials/${key}`,
    method: 'PUT',
    body: password,
    json: false,
    headers: {
      'Content-Type': 'text/plain'
    }
  };
  return request(options);
};

const deepFreeze = (obj) => {
  Object
    .keys(obj)
    .filter(prop => typeof obj[prop] === 'object' && !Object.isFrozen(obj[prop]))
    .forEach(prop => deepFreeze(obj[prop]));
  return Object.freeze(obj);
};

// delays executing a function that returns a promise with the provided interval (in ms)
const delayPromise = async (promiseFn, interval) => {
  if (typeof promiseFn === 'number') {
    interval = promiseFn;
    promiseFn = () => {};
  }

  await setTimeoutPromise(interval);
  return await promiseFn();
};

const setTransitionSeqToNow = () => {
  return Promise.all([
    sentinelDb.get('_local/transitions-seq').catch(() => ({ _id: '_local/transitions-seq' })),
    db.info()
  ]).then(([sentinelMetadata, { update_seq: updateSeq }]) => {
    sentinelMetadata.value = updateSeq;
    return sentinelDb.put(sentinelMetadata);
  });
};

const waitForDocRev = (ids) => {
  ids = ids.map(id => typeof id === 'string' ? { id: id, rev: 1 } : id);

  const validRow = row => {
    if (!row.id || !row.value || !row.value.rev) {
      return false;
    }

    const expectedRev = ids.find(id => id.id === row.id).rev;
    if (!expectedRev) {
      return false;
    }

    const existentRev = row.value.rev.split('-')[0];
    return Number(existentRev) >= Number(expectedRev);
  };

  const opts = {
    path: '/_all_docs',
    body: { keys: ids.map(id => id.id) },
    method: 'POST'
  };

  return requestOnTestDb(opts).then(results => {
    if (results.rows.every(validRow)) {
      return;
    }
    return delayPromise(() => waitForDocRev(ids), 100);
  });
};

const getDefaultSettings = () => {
  const pathToDefaultAppSettings = path.join(__dirname, '../config.default.json');
  return JSON.parse(fs.readFileSync(pathToDefaultAppSettings).toString());
};

const addTranslations = (languageCode, translations = {}) => {
  const builtinTranslations = [
    'bm',
    'en',
    'es',
    'fr',
    'hi',
    'id',
    'ne',
    'sw'
  ];
  const getTranslationsDoc = code => {
    return db.get(`messages-${code}`).catch(err => {
      if (err.status === 404) {
        return {
          _id: `messages-${code}`,
          type: 'translations',
          code: code,
          name: code,
          enabled: true,
          generic: {}
        };
      }

      throw err;
    });
  };

  return getTranslationsDoc(languageCode).then(translationsDoc => {
    if (builtinTranslations.includes(languageCode)) {
      originalTranslations[languageCode] = _.clone(translationsDoc.generic);
    }

    Object.assign(translationsDoc.generic, translations);
    return db.put(translationsDoc);
  });
};

const enableLanguage = (languageCode) => enableLanguages([languageCode]);

const enableLanguages = async (languageCodes) => {
  const { languages } = await getSettings();
  for (const languageCode of languageCodes) {
    const language = languages.find(language => language.locale === languageCode);
    if (language) {
      language.enabled = true;
    } else {
      languages.push({
        locale: languageCode,
        enabled: true,
      });
    }
  }
  await updateSettings({ languages });
};

const getSettings = () => getDoc('settings').then(settings => settings.settings);

const getTemplateComposeFilePath = file => path.resolve(__dirname, '../..', 'scripts', 'build', `${file}.yml.template`);

const getTestComposeFilePath = file => path.resolve(__dirname, `../${file}-test.yml`);

const generateK3DValuesFile = async () => {
  const view = {
    repo: `${K3D_REPO()}/${buildVersions.getRepo()}`,
    tag: buildVersions.getImageTag(),
    db_name: constants.DB_NAME,
    user: constants.USERNAME,
    password: constants.PASSWORD,
    secret: env.COUCHDB_SECRET,
    uuid: env.COUCHDB_UUID,
    namespace: PROJECT_NAME,
    data_path: K3D_DATA_PATH,
  };

  const templatePath = path.resolve(__dirname, '..', 'helm', `values.yaml.template`);
  const testValuesPath = path.resolve(__dirname, '..', 'helm', `values.yaml`);
  const template = await fs.promises.readFile(templatePath, 'utf-8');
  await fs.promises.writeFile(testValuesPath, mustache.render(template, view));
};

const generateComposeFiles = async () => {
  const view = {
    repo: buildVersions.getRepo(),
    tag: buildVersions.getImageTag(),
    db_name: constants.DB_NAME,
    couchdb_servers: 'couchdb-1.local,couchdb-2.local,couchdb-3.local',
  };

  for (const file of COMPOSE_FILES) {
    const templatePath = getTemplateComposeFilePath(file);
    const testComposePath = getTestComposeFilePath(file);

    const template = await fs.promises.readFile(templatePath, 'utf-8');
    await fs.promises.writeFile(testComposePath, mustache.render(template, view));
  }
};

const runAndLogApiStartupMessage = (msg, func) => {
  console.log(`API startup: ${msg}`);
  return func();
};

const setupSettings = () => {
  const defaultAppSettings = getDefaultSettings();
  defaultAppSettings.transitions = {};

  return request({
    path: '/api/v1/settings?replace=1',
    method: 'PUT',
    body: defaultAppSettings
  });
};

const createLogDir = async () => {
  const logDirPath = path.join(__dirname, '../logs');
  if (fs.existsSync(logDirPath)) {
    await fs.promises.rm(logDirPath, { recursive: true });
  }
  await fs.promises.mkdir(logDirPath);
};

const startServices = async () => {
  env.DB1_DATA = makeTempDir('ci-dbdata');
  env.DB2_DATA = makeTempDir('ci-dbdata');
  env.DB3_DATA = makeTempDir('ci-dbdata');

  await dockerComposeCmd('up -d');
  const services = await dockerComposeCmd('ps -q');
  if (!services.length) {
    throw new Error('Errors when starting services');
  }
};

const runCommand = (command, { verbose = true, overrideEnv = false } = {}) => {
  verbose && console.log(command);
  return new Promise((resolve, reject) => {
    exec(command, { env: overrideEnv || env }, (error, stdout, stderr) => {
      if (error) {
        verbose && console.error(error);
        return reject(error);
      }

      verbose && console.error(stderr);
      verbose && console.log(stdout);
      resolve(stdout);
    });
  });
};

const createCluster = async (dataDir) => {
  const hostPort = process.env.NGINX_HTTPS_PORT ? `${process.env.NGINX_HTTPS_PORT}` : '443';
  await runCommand(`k3d registry create ${K3D_REGISTRY}`);

  const port = await runCommand(`docker container port k3d-${K3D_REGISTRY}`);
  const match = port.trim().match(/:(\d+)$/);
  K3D_REGISTRY_PORT = match[1];

  await runCommand(
    `k3d cluster create ${PROJECT_NAME} ` +
    `--port ${hostPort}:443@loadbalancer ` +
    `--volume ${dataDir}:${K3D_DATA_PATH} --kubeconfig-switch-context=false ` +
    `--registry-use ${K3D_REPO()}`
  );
};

const importImages = async () => {
  const allImages = Object
    .keys(SERVICES)
    .map(service => {
      const serviceName = service.replace(/\d/, '');
      return `${buildVersions.getRepo()}/cht-${serviceName}:${buildVersions.getImageTag()}`;
    });
  const images = [...new Set(allImages)];

  for (const image of images) {
    // authentication to private repos is weird to set up in k3d.
    // https://k3d.io/v5.2.0/usage/registries/#authenticated-registries
    try {
      await runCommand(`docker image inspect ${image}`, { verbose: false });
    } catch {
      await runCommand(`docker pull ${image}`);
    }
    await runCommand(`docker tag ${image} ${K3D_REPO()}/${image}`);
    await runCommand(`docker push ${K3D_REPO()}/${image}`);
  }
};

const cleanupOldCluster = async () => {
  try {
    await runCommand(`k3d registry delete ${K3D_REGISTRY}`);
  } catch {
    console.warn('No registry to clean up');
  }
  try {
    await runCommand(`k3d cluster delete ${PROJECT_NAME}`);
  } catch {
    console.warn('No cluster to clean up');
  }
};

const prepK3DServices = async (defaultSettings) => {
  infrastructure = 'k3d';
  await createLogDir();

  const dataDir = makeTempDir('ci-dbdata');
  await fs.promises.mkdir(path.join(dataDir, 'srv1'));
  await fs.promises.mkdir(path.join(dataDir, 'srv2'));
  await fs.promises.mkdir(path.join(dataDir, 'srv3'));

  await cleanupOldCluster();
  await createCluster(dataDir);
  await generateK3DValuesFile();
  await importImages();

  const helmChartPath = path.join(__dirname, '..', 'helm');
  const valesPath = path.join(helmChartPath, 'values.yaml');
  await runCommand(
    `helm install ${PROJECT_NAME} ${helmChartPath} -n ${PROJECT_NAME} ` +
    `--kube-context k3d-${PROJECT_NAME} --values ${valesPath} --create-namespace`
  );
  await listenForApi();

  if (defaultSettings) {
    await runAndLogApiStartupMessage('Settings setup', setupSettings);
  }
  await runAndLogApiStartupMessage('User contact doc setup', setUserContactDoc);
  await runAndLogApiStartupMessage('Getting default forms', getDefaultForms);
};

const prepServices = async (defaultSettings) => {
  await createLogDir();
  await generateComposeFiles();

  updateContainerNames();

  await tearDownServices();
  await startServices();
  await listenForApi();
  if (defaultSettings) {
    await runAndLogApiStartupMessage('Settings setup', setupSettings);
  }
  await runAndLogApiStartupMessage('User contact doc setup', setUserContactDoc);
  await runAndLogApiStartupMessage('Getting default forms', getDefaultForms);
};

const getLogs = (container) => {
  const logFile = path.resolve(__dirname, '../logs', `${container.replace('pod/', '')}.log`);
  const logWriteStream = fs.createWriteStream(logFile, { flags: 'w' });
  const command = isDocker() ? 'docker' : 'kubectl';

  const params = `logs ${container} ${isK3D() ? KUBECTL_CONTEXT : ''}`.split(' ').filter(Boolean);

  return new Promise((resolve, reject) => {
    const cmd = spawn(command, params);
    cmd.on('error', (err) => {
      console.error('Error while collecting container logs', err);
      reject(err);
    });
    cmd.stdout.pipe(logWriteStream, { end: false });
    cmd.stderr.pipe(logWriteStream, { end: false });

    cmd.on('close', () => {
      resolve();
      logWriteStream.end();
    });
  });
};

const saveLogs = async () => {
  if (isK3D()) {
    const podsList = await runCommand(`kubectl ${KUBECTL_CONTEXT} get pods --no-headers -o name`);
    const pods = podsList.split('\n').filter(name => name);
    for (const podName of pods) {
      await getLogs(podName);
    }
    return;
  }

  for (const containerName of Object.values(CONTAINER_NAMES)) {
    await getLogs(containerName);
  }
};

const tearDownServices = async () => {
  await saveLogs();
  if (!DEBUG) {
    if (isK3D()) {
      return await cleanupOldCluster();
    }
    await dockerComposeCmd('down -t 0 --remove-orphans --volumes');
  }
};

const killSpawnedProcess = (proc) => {
  proc.stdout.destroy();
  proc.stderr.destroy();
  proc.kill('SIGINT');
};

/**
 * Watches a docker or kubernetes container log until at least one line matches one of the given regular expressions.
 *
 * Watch expires after 10 seconds.
 * @param {String} container - name of the container to watch
 * @param {Boolean} tail - when true, log is tailed. when false, whole log is analyzed. Always true for Docker.
 * @param {[RegExp]} regex - matching expression(s) run against lines
 * @returns {Promise<{cancel: function(): void, promise: Promise<void>}>}
 * that contains the promise to resolve when logs lines are matched and a cancel function
 */

const waitForLogs = (container, tail, ...regex) => {
  container = getContainerName(container);
  const cmd = isDocker() ? 'docker' : 'kubectl';
  let timeout;
  let logs = '';
  let firstLine = false;
  tail = (isDocker() || tail) ? '--tail=1' : '';

  // It takes a while until the process actually starts tailing logs, and initiating next test steps immediately
  // after watching results in a race condition, where the log is created before watching started.
  // As a fix, watch the logs with tail=1, so we always receive one log line immediately, then proceed with next
  // steps of testing afterward.
  const params = `logs ${container} -f ${tail} ${isK3D() ? KUBECTL_CONTEXT : ''}`.split(' ').filter(Boolean);
  const proc = spawn(cmd, params, { stdio: ['ignore', 'pipe', 'pipe'] });
  let receivedFirstLine;
  const firstLineReceivedPromise = new Promise(resolve => receivedFirstLine = resolve);

  const checkOutput = (data) => {
    if (!firstLine) {
      firstLine = true;
      receivedFirstLine();
      return;
    }

    data = data.toString();
    logs += data;
    const lines = data.split('\n');
    const matchingLine = lines.find(line => regex.find(r => r.test(line)));
    return matchingLine;
  };

  const promise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      console.log('Found logs', logs, 'did not match expected regex:', ...regex);
      reject(new Error('Timed out looking for details in logs.'));
      killSpawnedProcess(proc);
    }, 20000);

    const check = data => {
      const foundMatch = checkOutput(data);
      if (foundMatch || !regex.length) {
        resolve();
        clearTimeout(timeout);
        killSpawnedProcess(proc);
      }
    };

    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
  });

  return firstLineReceivedPromise.then(() => ({
    promise,
    cancel: () => {
      clearTimeout(timeout);
      killSpawnedProcess(proc);
    }
  }));
};

const waitForApiLogs = (...regex) => waitForLogs('api', true, ...regex);
const waitForSentinelLogs = (tail, ...regex) => waitForLogs('sentinel', tail, ...regex);
/**
 * Collector that listens to the given container logs and collects lines that match at least one of the
 * given regular expressions
 *
 * To use, call before the action you wish to catch, and then execute the returned function after
 * the action should have taken place. The function will return a promise that will succeed with
 * the list of captured lines, or fail if there have been any errors with log capturing.
 *
 * @param      {string}    container    container name
 * @param      {[RegExp]}  regex        matching expression(s) run against lines
 * @return     {Promise<function>}      promise that returns a function that returns a promise
 */
const collectLogs = (container, ...regex) => {
  container = getContainerName(container);
  const cmd = isDocker() ? 'docker' : 'kubectl';
  const matches = [];
  const errors = [];
  let logs = '';

  // It takes a while until the process actually starts tailing logs, and initiating next test steps immediately
  // after watching results in a race condition, where the log is created before watching started.
  // As a fix, watch the logs with tail=1, so we always receive one log line immediately, then proceed with next
  // steps of testing afterward.
  const params = `logs ${container} -f --tail=1 ${isK3D() ? KUBECTL_CONTEXT : ''}`.split(' ').filter(Boolean);
  const proc = spawn(cmd, params, { stdio: ['ignore', 'pipe', 'pipe'] });
  let receivedFirstLine;
  const firstLineReceivedPromise = new Promise(resolve => receivedFirstLine = resolve);

  proc.stdout.on('data', (data) => {
    receivedFirstLine();
    data = data.toString();
    logs += data;
    const lines = data.split('\n');
    lines.forEach(line => regex.forEach(r => r.test(line) && matches.push(line)));
  });
  proc.stderr.on('err', err => {
    receivedFirstLine();
    errors.push(err.toString());
  });

  proc.on('error', err => {
    receivedFirstLine();
    errors.push(err.toString());
  });

  const timeout = setTimeout(() => {
    receivedFirstLine();
    errors.push('Timed out waiting for first log line');
    killSpawnedProcess(proc);
  }, 180000);

  const collect = async () => {
    if (isK3D()) {
      await delayPromise(500);
    }
    clearTimeout(timeout);
    if (errors.length) {
      const error = new Error('CollectLogs errored');
      error.errors = errors;
      error.logs = logs;
      throw error;
    }

    return matches;
  };

  return firstLineReceivedPromise.then(() => collect);
};

const collectSentinelLogs = (...regex) => collectLogs('sentinel', ...regex);

const collectApiLogs = (...regex) => collectLogs('api', ...regex);

const collectHaproxyLogs = (...regex) => collectLogs('haproxy', ...regex);

const normalizeTestName = name => name.replace(/\s/g, '_');

const apiLogTestStart = async (name) => {
  try {
    await requestOnTestDb(`/?start=${normalizeTestName(name)}`);
  } catch (err) {
    console.error('Api is not up. Cancelling workflow', err);
    await saveLogs();
    process.exit(1);
  }
};

const apiLogTestEnd = (name) => {
  return requestOnTestDb(`/?end=${normalizeTestName(name)}`)
    .catch(() => console.warn('Error logging test end - ignoring'));
};

const updateContainerNames = (project = PROJECT_NAME) => {
  Object.entries(SERVICES).forEach(([key, service]) => {
    CONTAINER_NAMES[key] = getContainerName(service, project);
  });
  CONTAINER_NAMES.upgrade = getContainerName('cht-upgrade-service', 'upgrade');
};

const getContainerName = (service, project = PROJECT_NAME) => {
  return isDocker() ? `${project}-${service}-1` : `deployment/cht-${service}`;
};

const getUpdatedPermissions = async (roles, addPermissions, removePermissions) => {
  const settings = await getSettings();
  addPermissions.forEach(permission => {
    if (!settings.permissions[permission]) {
      settings.permissions[permission] = [];
    }
    settings.permissions[permission].push(...roles);
  });

  (removePermissions || []).forEach(permission => settings.permissions[permission] = []);
  return settings.permissions;
};

const updatePermissions = async (roles, addPermissions, removePermissions, options = {}) => {
  const permissions = await getUpdatedPermissions(roles, addPermissions, removePermissions);
  const { ignoreReload = false, revert = false, refresh = false, sync = false } = options;
  await updateSettings(
    { permissions },
    { ignoreReload, revert, refresh, sync }
  );
};

const getSentinelDate = () => getContainerDate('sentinel');
const getPodName = async (service, verbose) => {
  const cmd = await runCommand(
    `kubectl get pods ${KUBECTL_CONTEXT} -l cht.service=${service} --field-selector=status.phase==Running -o name`,
    { verbose }
  );
  return cmd.replace(/[^A-Za-z0-9-/]/g, '');
};

const getContainerDate = async (container) => {
  let date;
  if (isDocker()) {
    container = getContainerName(container);
    date = await runCommand(`docker exec ${container} date -R`);
  } else {
    const podName = await getPodName(container);
    date = await runCommand(`kubectl exec ${KUBECTL_CONTEXT} ${podName} -- date -R`);
  }
  return moment.utc(date);
};

const logFeedbackDocs = async (test) => {
  const feedBackDocs = await chtDbUtils.getFeedbackDocs();
  const newFeedbackDocs = feedBackDocs.filter(doc => !existingFeedbackDocIds.includes(doc._id));
  if (!newFeedbackDocs.length) {
    return false;
  }

  const filename = `feedbackDocs-${test.parent} ${test.title}.json`.replace(/\s/g, '-');
  const filePath = path.resolve(__dirname, '..', 'logs', filename);
  fs.writeFileSync(filePath, JSON.stringify(newFeedbackDocs, null, 2));
  existingFeedbackDocIds.push(...newFeedbackDocs.map(doc => doc._id));

  return true;
};

const isMinimumChromeVersion = process.env.CHROME_VERSION === MINIMUM_BROWSER_VERSION;

const escapeBranchName = (branch) => branch?.replace(/[/|_]/g, '-');

const toggleSentinelTransitions = () => sendSignal('sentinel', 'USR1');
const runSentinelTasks = () => sendSignal('sentinel', 'USR2');

module.exports = {
  db,
  sentinelDb,
  logsDb,
  usersDb,
  auditDb,

  SW_SUCCESSFUL_REGEX,
  ONE_YEAR_IN_S,
  PROJECT_NAME,
  makeTempDir,
  hostURL,
  parseCookieResponse,
  setupUserDoc,
  request,
  requestOnTestDb,
  requestOnTestMetaDb,
  requestOnMedicDb,
  saveDoc,
  saveDocs,
  saveDocsRevs,
  saveDocIfNotExists,
  saveMetaDocs,
  getDoc,
  getDocs,
  getMetaDocs,
  deleteDoc,
  deleteDocs,
  deleteAllDocs,
  updateSettings,
  revertSettings,
  seedTestData,
  revertDb,
  getOrigin,
  getBaseUrl,
  getAdminBaseUrl,
  deleteUsers,
  getCreatedUsers,
  createUsers,
  getUserSettings,
  listenForApi,
  stopSentinel,
  startSentinel,
  stopApi,
  startApi,
  stopHaproxy,
  startHaproxy,
  saveCredentials,
  deepFreeze,
  delayPromise,
  setTransitionSeqToNow,
  waitForDocRev,
  getDefaultSettings,
  addTranslations,
  enableLanguage,
  enableLanguages,
  getSettings,
  prepServices,
  prepK3DServices,
  tearDownServices,
  waitForApiLogs,
  waitForSentinelLogs,
  collectSentinelLogs,
  collectApiLogs,
  collectHaproxyLogs,
  apiLogTestStart,
  apiLogTestEnd,
  updateContainerNames,
  updatePermissions,
  getUpdatedPermissions,
  formDocProcessing,
  getSentinelDate,
  logFeedbackDocs,
  isMinimumChromeVersion,
  escapeBranchName,
  isK3D,
  stopCouchDb,
  startCouchDb,
  getDefaultForms,
  toggleSentinelTransitions,
  runSentinelTasks,
  runCommand,
  deletePurgeDbs,
  saveLogs,
};
