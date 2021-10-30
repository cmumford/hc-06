/**
 * Enumeration for the HC-06 device properties.
 */
const DeviceProperty = {
  Name: 'Name',
  PIN: 'PIN',
  Baud: 'Baud',
  Parity: 'Parity',
  Role: 'Role'
};

/**
 * Enumeration for the last write state of a device property.
 */
const WriteState = {
  Unwritten: 'Unwritten',
  Writing: 'Writing',
  Error: 'Error',
  Success: 'Success'
};

var deviceState = {
  baudRate: 9600,  // bps.
  parity: 'none',  // 'none', 'even', or 'odd'.
  name: 'HC-06',   // Device's Bluetooth name.
  pin: '1234',     // four digit number.
  mode: 'slave'    // 'master' or 'slave'.
};
var port;    // Defined only when port is open.
var reader;  // Active port reader.
var lastOpenedPortInfo;
var deviceStateDb;
var portStatus = 'closed';  // 'closed', 'opening', 'open', and 'open-error'.
var createdDatabase =
  false;  // There was no settings db at page load and was created.
var deviceUpdated =
  false;  // The settings were written (at least once) to device.
var changeNameTimeout;
var changePinTimeout;
var responseTimeout;
var currentResponseLine = '';
var pendingResponsePromises = [];
const kDbName = 'HC-06';
const kDbVersion = 1;
const kDbObjStoreName = 'state';
const kDbPrimaryKeyName = 'id';
const kDbPrimaryKeyValue = 1;
const parityAbbrevToName = {};  // Abbrev ("PO", etc.) to name ("odd", etc.).
const roleAbbrevToName = {};  // Abbrev ("M", "S") to name ("master", "slave");
const baudAbbrevToName = {};  // Abbrev ("1", "2") to name ("1200", "2400");
const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

function $(id) {
  return document.getElementById(id);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Given a dictionary value return the corresponding key.
 *
 * @param {dict} dict
 * @param {*} value
 * @returns The key corresponding to |value| or undefined.
 */
function dictReverseLookup(dict, value) {
  foundValue = undefined;
  Object.entries(dict).forEach(([k, v]) => {
    if (value == v) {
      foundValue = k;
    }
  });
  return foundValue;
}

function isControlChar(ch) {
  return ch === '\r' || ch === '\n';
}

/**
 * Send the response text to the pending promises.
 *
 * @param {string} response The response text from the device.
 */
function resolveResponsePromises(response) {
  console.log(`Got response: "${response}"`);
  if (pendingResponsePromises.length) {
    pendingResponsePromises.forEach((promise) => {
      promise.resolve(response);
    });
    pendingResponsePromises = [];
  } else {
    console.warn(`Got device unexpected response: "${response}"`);
  }
}

/**
 * Process some response data from the device.
 *
 * @param {*} data The binary response data read from the serial port.
 */
function handleDeviceResponseData(data) {
  const text = utf8Decoder.decode(data).trim();
  if (text.length == 0) {
    return;
  }
  if (responseTimeout) {
    window.clearTimeout(responseTimeout);
    responseTimeout = undefined;
  }
  currentResponseLine = currentResponseLine.concat(text);
  const kResponseTimeoutMs = 100;
  responseTimeout = window.setTimeout(() => {
    responseTimeout = undefined;
    resolveResponsePromises(currentResponseLine);
    currentResponseLine = '';
  }, kResponseTimeoutMs);
}

/**
 * Is the Web Serial API supported by this browser?
 *
 * @return {bool} true if supported, false if not.
 */
function isWebSerialSupported() {
  return 'serial' in navigator;
}

/**
 * Read the saved device state from the database.
 *
 * @param {object} db The open Indexed DB.
 * @returns {Promise<object>} A promise that resolves to the database state dictionary.
 */
function getDbData(db) {
  return new Promise((resolve, reject) => {
    var transaction = db.transaction([kDbObjStoreName], 'readwrite');
    transaction.onerror = (event) => {
      reject(`Get transaction error: ${event.target.errorCode}`);
    };
    var store = transaction.objectStore(kDbObjStoreName);
    var request = store.get(kDbPrimaryKeyValue);
    request.onsuccess = (event) => {
      resolve(request.result);
    };
  });
}

/**
 * Write the current device state to the database.
 *
 * @param {object} db An open Indexed DB.
 * @returns {Promise<undefined>} A promise that resolves when writing completed.
 */
function putDbData(db) {
  return new Promise((resolve, reject) => {
    var transaction = db.transaction([kDbObjStoreName], 'readwrite');
    transaction.onerror = (event) => {
      reject(`Put transaction error: ${event.target.errorCode}`);
    };
    var store = transaction.objectStore(kDbObjStoreName);
    var request = store.put(deviceState, kDbPrimaryKeyValue);
    request.onsuccess = resolve;
  });

}

// Open the device state database and read the saved device state.
function loadSavedDeviceState() {
  var dbOpenRequest = window.indexedDB.open(kDbName, kDbVersion);
  dbOpenRequest.onerror = (event) => {
    console.error(`Error opening device db, err: ${event.target.errorCode}`);
  };
  dbOpenRequest.onsuccess = async (event) => {
    deviceStateDb = event.target.result;
    deviceState = await getDbData(event.target.result);
    setControlValues();
    setControlState();
  };
  dbOpenRequest.onupgradeneeded = (event) => {
    console.log('Created device state database.');
    createdDatabase = true;
    var db = event.target.result;
    var objectStore = db.createObjectStore(kDbObjStoreName);
    objectStore.transaction.oncomplete = async (event) => {
      await putDbData(db);
    };
  };
}

/**
 * Is the serial port currently open?
 *
 * @returns true/false.
 */
function isPortOpen() {
  return !!port;
}

/**
 * Send an AT command and return the device response.
 *
 * @param {string} payload The AT command payload. Can be empty.
 * @returns {Promise<string>} A promise that resolves to the device response.
 */
async function sendAtCommand(payload) {
  if (!isPortOpen()) {
    throw new Error('Port not opened.');
  }
  var promise = new Promise((resolve, reject) => {
    // The goal is to defer resolution until the next line
    // response text is received from the device.
    // Believe this is the **wrong** way to do this.
    pendingResponsePromises.push({ resolve: resolve, reject: reject });
  });

  const message = payload ? `AT+${payload}` : 'AT';
  const writer = port.writable.getWriter();
  try {
    await writer.write(utf8Encoder.encode(message));
  } finally {
    writer.releaseLock();
  }
  return promise;
}

async function setPortBaud(baudValue) {
  const response = await sendAtCommand(`BAUD${baudValue}`);
  if (!response || !response.startsWith('OK')) {
    throw new Error(`Unable to set baud: \"${response}\"`);
  }
}

/**
 * Set the device parity and update the database.
 *
 * @param {string} parity One of "PN" (none), "PO" (odd), or "PE" (even).
 */
async function setParity(parity) {
  const response = await sendAtCommand(parity);
  if (!response || !response.startsWith('OK')) {
    throw new Error(`Unable to set parity: \"${response}\"`);
  }
}

/**
 * Set the device role and update the database.
 *
 * @param {string} role The role. Either "M" (master) or "S" (slave).
 */
async function setRole(role) {
  const response = await sendAtCommand(`ROLE=${role}`);
  if (!response || !response.startsWith('OK')) {
    throw new Error(`Unable to set role: \"${response}\"`);
  }
}

async function setDeviceName(name) {
  if (name.length > 20) {
    throw new Error('Name too long: 20 chars max');
  }
  const response = await sendAtCommand(`NAME${name}`);
  if (!response || (response != 'OKsetname' && response != 'OKname')) {
    throw new Error(`Unable to set name: \"${response}\"`);
  }
}

async function setDevicePin(pin) {
  if (pin.length != 4) {
    throw new Error('PIN length must be 4 characters');
  }
  const response = await sendAtCommand(`PIN${pin}`);
  console.log(response);
  if (!response || response.toLowerCase() != 'oksetpin') {
    reject(`Unable to set PIN: \"${response}\"`);
  }
}

/**
 * Send a known message to the device to verify ability to communicate.
 *
 * @returns {Promise<boolean>} true when successful else false.
 */
async function ping() {
  const response = await sendAtCommand();
  return response == 'OK';
}

async function getVersion() {
  const response = await sendAtCommand('VERSION');
  // Some devices echo back OK before version, others do not.
  if (response.startsWith('OK')) {
    return response.substr(2);
  } else {
    return response;
  }
}

/**
 * Close the serial port.
 *
 * @return {Promise<undefined>} A promise that resolves when the port closes.
 */
async function closePort() {
  try {
    const localPort = port;
    port = undefined;

    if (reader) {
      await reader.cancel();
    }

    clearConnectionState();
    await localPort.close();
  } finally {
    setControlState();
  }
}

/**
 * Read all data from the serial port as long as it is open.
 */
async function readPortData() {
  while (port && port.readable) {
    try {
      reader = port.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          handleDeviceResponseData(value);
        }
        if (done) {
          break;
        }
      }
      reader.releaseLock();
      reader = undefined;
    } catch (ex) {
      console.error(ex);
    }
  }
  // Function gets here when the port has been closed.
  if (port) {
    // unexpected closure (like disconnected USB adapter).
    try {
      clearConnectionState();
      await port.close();
    } catch (ex) {
      console.error(ex);
    }
    port = undefined;
    setControlState();
  }
}

/**
 * Start an async serial port reader.
 */
function startPortReader() {
  setTimeout(() => {
    readPortData();
  }, 0);
}

/**
 * Reset any global variables back to where they should be
 * with a closed serial port.
 */
function clearConnectionState() {
  deviceUpdated = false;
  if (changeNameTimeout) {
    window.clearTimeout(changeNameTimeout);
    changeNameTimeout = undefined;
  }
  if (changePinTimeout) {
    window.clearTimeout(changePinTimeout);
    changePinTimeout = undefined;
  }
  if (responseTimeout) {
    window.clearTimeout(responseTimeout);
    responseTimeout = undefined;
  }

  portStatus = 'closed';

  currentResponseLine = '';
  pendingResponsePromises.forEach((promise) => {
    promise.reject(Error('port closed'));
  });
  pendingResponsePromises = [];

  Object.entries(DeviceProperty).forEach(([k, v]) => {
    setValueWriteState(k, WriteState.Unwritten);
  });
}

/**
 * Open the serial port.
 *
 * @return {Promise<undefined>} A promise that resolves after the port opens.
 */
async function openPort(toOpen) {
  console.log(`Opening port baud: ${deviceState.baudRate}`);
  try {
    portStatus = 'opening';
    await toOpen.open({
      baudRate: deviceState.baudRate,
      parity: deviceState.parity,
      dataBits: 8,
      stopBits: 1,
      flowControl: 'none'
    });
    port = toOpen;
    lastOpenedPortInfo = await port.getInfo();
    deviceUpdated = false;
    startPortReader();
    await putDbData(deviceStateDb);
  } finally {
    setControlState();
  }
}

/**
 * Return the port currently selected in the port selection menu.
 *
 * @return {object} selected port or null if none selected.
 */
function getSelectedPort() {
  const selectObject = $('connection-port');
  if (selectObject.selectedOptions.length) {
    return selectObject.selectedOptions[0].port;
  }
  return null;
}

/**
 * Return the port to open.
 *
 * @returns {object} The port to open.
 */
async function getPortToOpen() {
  var selectedPort = getSelectedPort();
  if (selectedPort) {
    return selectedPort;
  }
  return await navigator.serial.requestPort();
}

/**
 * Processing of some commands on *some* HC-06's appears to take some
 * time to complete. If commands are run back-to-back then we must
 * add a delay for the HC-06 to return to a state where it is ready to
 * execute the next command. Otherwise the next command-request hangs.
 *
 * This is empirically determined. Not documented in datasheet.
 */
async function sleepDeviceCommandInterval() {
  await sleep(1000);
}

/**
 * Open the serial port and verify the device is responsive.
 *
 * @param {object} thePort
 */
async function openPortVerifyDevice(thePort) {
  await openPort(thePort);
  const gotResponse = await ping();
  if (gotResponse) {
    portStatus = 'open';
  } else {
    throw new Error(`Device ping failed.`);
  }
  await sleepDeviceCommandInterval();
  const version = await getVersion();
  console.info(`version: "${version}"`);
}

/**
 * Close (if currently open) and open the serial port.
 *
 * @return {Promise<undefined>} A promise that resolves when the port opens.
 */
async function reopenPort() {
  try {
    var portToOpen = port;
    if (isPortOpen()) {
      await closePort();
    }
    if (!portToOpen) {  // If not one previously open.
      portToOpen = await getPortToOpen();
      if (!portToOpen) {
        throw new Error(`No port to open`);
      }
    }

    await sleepDeviceCommandInterval();
    await openPortVerifyDevice(portToOpen);
  } catch (ex) {
    console.error('Unable to reopen serial port: ' + ex);
    if (ex.message != 'port closed') {
      portStatus = 'open-error';
    }
  } finally {
    setConnectBannerState();
  }
}

/**
 * Toggle the open state of the currently selected serial port.
 *
 * @return {Promise<undefined>} A promise that resolves when the port opens or
 *     closes.
 */
async function toggleConnectState() {
  try {
    if (isPortOpen()) {
      closePort();
    } else {
      portStatus = 'opening';
      const portToOpen = await getPortToOpen();
      if (!portToOpen) {
        throw new Error(`No port to open`);
      }
      await openPortVerifyDevice(portToOpen);
    }
  } catch (ex) {
    console.error('Unable to toggle serial port: ' + ex);
    if (ex.message != 'port closed') {
      portStatus = 'open-error';
    }
  } finally {
    setConnectBannerState();
  }
}

/**
 * One time initialization.
 */
async function init() {
  getMenuValues();

  if (!isWebSerialSupported()) {
    console.log('Web Serial not supported.');
    $('web_serial_available').style.display = 'none';
    if (window.isSecureContext == 'https') {
      $('web_serial_none').style.display = 'block';
    } else {
      $('web_serial_insecure').style.display = 'block';
    }
    return;
  }

  // Believe Web Serial API is always available. Confirm and delete this
  // section if so.
  const available = true;
  if (!available) {
    $('web_serial_available').style.display = 'none';
    $('web_serial_unavailable').style.display = 'block';
  }

  navigator.serial.addEventListener('connect', (event) => {
    console.log('A serial port has been connected.');
    setControlState();
  });
  navigator.serial.addEventListener('disconnect', (event) => {
    console.log('A serial port has been disconnected.');
    setControlState();
  });

  loadSavedDeviceState();
  setControlState();
}

/**
 * Callback when device baud is changed.
 *
 * @param {object} selectObject The HTML select object.
 * @returns {Promise<undefined>} A promise that resolves when the port is
 *          reopened (if previously opened) else immediately.
 */
async function onBaudSelected(selectObject) {
  const value = selectObject.value;
  deviceState.baudRate = baudAbbrevToName[value];
  if (isPortOpen()) {
    try {
      setValueWriteState(DeviceProperty.Baud, WriteState.Writing);
      await setPortBaud(value);
      await putDbData(deviceStateDb);
      setValueWriteState(DeviceProperty.Baud, WriteState.Success);
    } catch (ex) {
      setValueWriteState(DeviceProperty.Baud, WriteState.Error);
    }

    await sleepDeviceCommandInterval();

    await reopenPort();
  }
}

/**
 * Call when device parity is changed.
 *
 * @param {object} selectObject The HTML select object.
 * @returns {Promise<undefined>} A promise that resolves when the port is
 *          reopened (if previously opened) else immediately.
 */
async function onParitySelected(selectObject) {
  const abbrev = selectObject.value;
  var newParity = parityAbbrevToName[abbrev];
  if (isPortOpen()) {
    try {
      setValueWriteState(DeviceProperty.Parity, WriteState.Writing);
      await setParity(abbrev);
      deviceState.parity = newParity;
      await putDbData(deviceStateDb);
      setValueWriteState(DeviceProperty.Parity, WriteState.Success);
      await reopenPort();
    } catch (ex) {
      setValueWriteState(DeviceProperty.Parity, WriteState.Error);
    }
    await reopenPort();
  }
}

/**
 * Call when device role is changed.
 *
 * @param {object} selectObject The HTML select object.
 * @returns {Promise<undefined>} A promise that resolves when the device
 *          role has been changed on device (if currently opened) else
 *          immediately.
 */
async function onRoleSelected(selectObject) {
  const abbrev = selectObject.value;
  if (isPortOpen()) {
    try {
      setValueWriteState(DeviceProperty.Role, WriteState.Writing);
      await setRole(abbrev);
      deviceState.mode = roleAbbrevToName[abbrev];
      await putDbData(deviceStateDb);
      setValueWriteState(DeviceProperty.Role, WriteState.Success);
    } catch (ex) {
      setValueWriteState(DeviceProperty.Role, WriteState.Error);
    }
  }
}

/**
 * Retrieve the parity, role, and speed key/value pairs from
 * the DOM.
 */
function getMenuValues() {
  for (const option of $('aligned-parity').options) {
    parityAbbrevToName[option.value] = option.innerText;
  }
  for (const option of $('aligned-role').options) {
    roleAbbrevToName[option.value] = option.innerText;
  }
  for (const option of $('aligned-baud').options) {
    const speed = option.innerText.replaceAll(',', '');
    baudAbbrevToName[option.value] = speed;
  }
}

/**
 * Add available ports to the port menu.
 */
async function populatePortMenu() {
  const portMenu = $('connection-port');
  var i, L = portMenu.options.length - 1;
  for (i = L; i >= 0; i--) {
    portMenu.remove(i);
  }

  const ports = await navigator.serial.getPorts();
  if (ports.length == 0) {
    return;
  }
  var option;
  ports.forEach(port => {
    option = document.createElement('option');
    const portInfo = port.getInfo();
    option.text = `V:${portInfo.usbVendorId}/P:${portInfo.usbProductId}`;
    option.port = port;
    portMenu.add(option);
  });

  option = document.createElement('option');
  option.text = 'Select other port...';
  option.port = null;
  portMenu.add(option);

  var idxToSelect = 0;
  if (lastOpenedPortInfo) {
    for (i = 0; i < portMenu.options.length; i++) {
      if (portMenu.options[i].port) {
        const info = await portMenu.options[i].port.getInfo();
        if (info.usbProductId == lastOpenedPortInfo.usbProductId &&
          info.usbVendorId == lastOpenedPortInfo.usbVendorId) {
          idxToSelect = i;
          break;
        }
      }
    }
  }
  portMenu.selectedIndex = idxToSelect;
}

/**
 * Timeout callback to update the currently open device name
 * with the current value from the form.
 */
async function changeNameCallback() {
  changeNameTimeout = undefined;

  const name = $('aligned-name').value;
  if (name.length > 0 && name.length <= 20) {
    console.log(`Setting device name to "${name}"`);
    try {
      setValueWriteState(DeviceProperty.Name, WriteState.Writing);
      await setDeviceName(name);
      deviceState.name = name;
      await putDbData(deviceStateDb);
      setValueWriteState(DeviceProperty.Name, WriteState.Success);
    } catch (ex) {
      setValueWriteState(DeviceProperty.Name, WriteState.Error);
    }
  }
}

/**
 * Start (or restart) a 1/2 sec. timeout to update the device
 * name from the input form field.
 *
 * @param {object} element The name input form element.
 */
function onNameChanged(element) {
  if (changeNameTimeout) {
    window.clearTimeout(changeNameTimeout);
    changeNameTimeout = undefined;
  }
  changeNameTimeout =
    window.setTimeout(changeNameCallback, /*milliseconds=*/ 500);
}

/**
 * Timeout callback to update the currently open device PIN
 * with the current value from the form.
 */
async function changePinCallback() {
  changePinTimeout = undefined;

  const pin = $('aligned-pin').value;
  console.log(`Setting PIN to "${pin}"`);
  try {
    setValueWriteState(DeviceProperty.PIN, WriteState.Writing);
    await setDevicePin(pin);
    deviceState.pin = pin;
    await putDbData(deviceStateDb);
    setValueWriteState(DeviceProperty.PIN, WriteState.Success);
  } catch (ex) {
    setValueWriteState(DeviceProperty.PIN, WriteState.Error);
  }
}

/**
 * Start (or restart) a 1/2 sec. timeout to update the device
 * PIN from the input form field.
 *
 * @param {object} element The name input form element.
 */
function onPinChanged(element) {
  if (changePinTimeout) {
    window.clearTimeout(changePinTimeout);
    changePinTimeout = undefined;
  }
  changePinTimeout =
    window.setTimeout(changePinCallback, /*milliseconds=*/ 500);
}

/**
 * Set the state of the connect banner.
 */
function setConnectBannerState() {
  var toggleConnect = $('toggle-connect');
  var connectBanner = $('connect-banner');
  const banner_styles = [
    'closed',
    'open-error',
    'opened',
    'opening',
  ];

  banner_styles.forEach((style_name) => {
    connectBanner.classList.remove(style_name);
  });

  if (isPortOpen()) {
    toggleConnect.innerText = 'Disconnect';
    if (portStatus == 'opening') {
      connectBanner.classList.add('opening');
    } else if (portStatus == 'open-error') {
      connectBanner.classList.add('open-error');
    } else {
      connectBanner.classList.add('opened');
    }
    $('connect-info').style.visibility = 'hidden';
  } else {
    toggleConnect.innerText = 'Connect';
    if (portStatus == 'open-error') {
      connectBanner.classList.add('open-error');
    } else {
      connectBanner.classList.add('closed');
    }
    $('connect-info').style.visibility = 'visible';
  }
}

/**
 * Given a property return the DOM node ID.
 *
 * @param {string} prop The property enum value from DeviceProperty.
 * @returns {string} The DOM node ID.
 */
function getPropertyStateNodeId(prop) {
  return `${prop.toLowerCase()}-write-status`;
}

function setWriteStateClass(element, style) {
  const allStatusClasses = [
    'write-status-hidden',
    'write-status-writing',
    'write-status-error',
    'write-status-success'
  ];

  allStatusClasses.forEach((remStyle) => {
    element.classList.remove(remStyle);
  });

  element.classList.add(style);
}

/**
 * Set the UI state for the given property to reflect the last write state.
 *
 * @param {string} prop The property enum value (from DeviceProperty).
 * @param {string} state The last write state (from WriteState).
 */
function setValueWriteState(prop, state) {
  const elemId = getPropertyStateNodeId(prop);
  const elem = $(elemId);
  switch (state) {
    case WriteState.Unwritten:
      setWriteStateClass(elem, 'write-status-hidden');
      elem.innerText = '';
      break;
    case WriteState.Writing:
      setWriteStateClass(elem, 'write-status-writing');
      elem.innerText = '(updating)';
      break;
    case WriteState.Error:
      setWriteStateClass(elem, 'write-status-error');
      elem.innerText = '(ERROR)';
      break;
    case WriteState.Success:
      setWriteStateClass(elem, 'write-status-success');
      elem.innerText = '(updated)';
      break;
  }
}

/**
 * Adjust control states according to the state of this
 * application.
 */
async function setControlState() {
  populatePortMenu();

  $('aligned-name').disabled = !isPortOpen();
  $('aligned-pin').disabled = !isPortOpen();
  $('aligned-role').disabled = !isPortOpen();

  setConnectBannerState();

  $('aligned-name').value = deviceState.name;
  $('aligned-pin').value = deviceState.pin;

  const ports = await navigator.serial.getPorts();
  if (ports.length > 0 && !isPortOpen()) {
    $('open-port-div').style.visibility = 'visible';
  } else {
    $('open-port-div').style.visibility = 'hidden';
  }
}

/**
 * Set control values to match application state.
 */
function setControlValues() {
  const value =
    parseInt(dictReverseLookup(baudAbbrevToName, deviceState.baudRate), 16);
  const index = value - 1;
  $('aligned-baud').selectedIndex = index;
}
