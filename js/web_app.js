var deviceState = {
  baudRate: 9600,  // bps.
  parity: 'none',  // 'none', 'even', or 'odd.
  name: 'HC-06',   // Device's Bluetooth name.
  pin: '1234',     // four digit number.
  mode: 'master'   // 'master' or 'slave'.
};
var port; // Defined only when port is open.
var reader; // Active port reader.
var lastOpenedPortInfo;
var deviceStateDb;
var createdDatabase = false; // There was no settings db at page load and was created.
var deviceUpdated = false;   // The settings were written (at least once) to device.
var changeNameTimeout;
var changePinTimeout;
var lastResponse;
var currentResponseLine = '';
const kDbName = 'HC-06';
const kDbVersion = 1;
const kDbObjStoreName = 'state';
const kDbPrimaryKeyName = 'id';
const kDbPrimaryKeyValue = 1;
const parityAbbrevToName = {};  // Abbrev ("PO", etc.) to name ("odd", etc.).
const roleAbbrevToName = {};  // Abbrev ("M", "S") to name ("master", "slave");
const baudAbbrevToName = {};  // Abbrev ("1", "2") to name ("1200", "2400");
const utf8Decoder = new TextDecoder();

function $(id) {
  return document.getElementById(id);
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

/**
 * Append device response to UI section.
 * @param {string} response The device response to log.
 */
function logResponse(response) {
  const status = $('response');
  const br = document.createElement('br');
  const text = document.createTextNode(response);
  status.appendChild(br);
  status.appendChild(text);
}

function isControlChar(ch) {
  return ch === '\r' || ch === '\n';
}

function logResponseData(data) {
  const text = utf8Decoder.decode(data);
  var i;
  for (i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (isControlChar(ch)) {
      while (i < text.length && isControlChar(text.charAt(i))) {
        i += 1;
      }
      logResponse(currentResponseLine);
      lastResponse = currentResponseLine;
      currentResponseLine = '';
    } else {
      currentResponseLine = currentResponseLine.concat(ch);
    }
  }
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
 * Write the current device state to the database.
 */
function getDbData(db) {
  var transaction = db.transaction([kDbObjStoreName], 'readwrite');
  transaction.oncomplete = (event) => {
    setControlValues();
  };
  transaction.onerror = (event) => {
    console.error(`Get transaction error: ${event.target.errorCode}`);
  };
  var store = transaction.objectStore(kDbObjStoreName);
  var request = store.get(kDbPrimaryKeyValue);
  request.onsuccess = (event) => {
    deviceState = request.result;
    setControlState();
  };
}

/**
 * Read the current device state from the database.
 */
function putDbData(db) {
  var transaction = db.transaction([kDbObjStoreName], 'readwrite');
  transaction.oncomplete = (event) => { };
  transaction.onerror = (event) => {
    console.error(`Put transaction error: ${event.target.errorCode}`);
  };
  var store = transaction.objectStore(kDbObjStoreName);
  var request = store.put(deviceState, kDbPrimaryKeyValue);
  request.onsuccess = (event) => { };
}

// Open the device state database and read the saved device state.
function loadSavedDeviceState() {
  var dbOpenRequest = window.indexedDB.open(kDbName, kDbVersion);
  dbOpenRequest.onerror = (event) => {
    console.error(`Error opening device db, err: ${event.target.errorCode}`);
  };
  dbOpenRequest.onsuccess = async (event) => {
    deviceStateDb = event.target.result;
    getDbData(event.target.result);
  };
  dbOpenRequest.onupgradeneeded = (event) => {
    console.log('Created device state database.');
    createdDatabase = true;
    var db = event.target.result;
    var objectStore = db.createObjectStore(kDbObjStoreName);
    objectStore.transaction.oncomplete = (event) => {
      putDbData(db);
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
 * Event handler for serial port connection.
 *
 * @param {Event} event (unused)
 */
function onConnect(event) {
  console.log('A serial port has been connected.');
  setControlState();
}

/**
 * Event handler for serial port disconnection.
 *
 * @param {Event} event (unused)
 */
function onDisconnect(event) {
  console.log('A serial port has been disconnected.');
  setControlState();
}

/**
 * Send an AT command.
 *
 * @param {string} payload The AT command payload. Can be empty.
 * @returns {Promise<string>} A promise that resolves to the device response.
 */
async function sendAtCommand(payload) {
  if (!isPortOpen()) {
    throw Error('Port not connected.');
  }
  const write_string = payload ? 'AT' + payload : 'AT';
  const writer = port.writable.getWriter();
  await writer.write(new TextEncoder().encode(write_string));
  writer.releaseLock();
  const myPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve(lastResponse);
    }, 300);
  });
  return myPromise;
}

async function setPortBaud(baudValue) {
  const response = await sendAtCommand(`+BAUD${baudValue}`);
  putDbData(deviceStateDb);
}

/**
 * Set the device parity and update the database.
 *
 * @param {string} parity One of "PN" (none), "PO" (odd), or "PE" (even).
 */
async function setParity(parity) {
  const response = await sendAtCommand(`+${parity}`);
  putDbData(deviceStateDb);
}

/**
 * Set the device role and update the database.
 *
 * @param {string} role The role. Either "M" (master) or "S" (slave).
 */
async function setRole(role) {
  const response = await sendAtCommand(`+ROLE=${role}`);
  putDbData(deviceStateDb);
}

async function setDeviceName(name) {
  if (name.length > 20) {
    throw Error('Name too long: 20 chars max');
  }
  console.log(`Setting name to "${name}"`)
  const response = await sendAtCommand(`+NAME${name}`);
  deviceState.name = name;
  putDbData(deviceStateDb);
}

async function setPinName(pin) {
  if (pin.length != 4) {
    throw Error('PIN length must be 4 characters');
  }
  console.log(`Setting PIN to "${PIN}"`)
  const response = await sendAtCommand(`+PIN${pin}`);
  deviceState.pin = pin;
  putDbData(deviceStateDb);
}

async function ping() {
  const response = await sendAtCommand();
  logResponse(`Ping response: "${response}"`);
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

async function readPortData() {
  while (port && port.readable) {
    try {
      reader = port.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          logResponseData(value);
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
  // App gets here when the port has been closed.
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

function startPortReader() {
  setTimeout(() => {
    readPortData();
  }, 0);
}

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
  lastResponse = undefined;
  currentResponseLine = '';

  const response = $('response');
  while (response.firstChild) {
    response.removeChild(response.firstChild);
  }
}

/**
 * Open the serial port.
 *
 * @return {Promise<undefined>} A promise that resolves when the port opens.
 */
async function openPort(toOpen) {
  console.log(`Opening port baud: ${deviceState.baudRate}`);
  try {
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
    putDbData(deviceStateDb);
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
  port = getSelectedPort();
  if (port) {
    return port;
  }
  return await navigator.serial.requestPort();
}

/**
 * Close (if currently open) and open the serial port.
 *
 * @return {Promise<undefined>} A promise that resolves when the port opens.
 */
async function reopenPort() {
  if (isPortOpen()) {
    await closePort();
  }
  openCurrentPort();
}

/**
 * Open the currently selected port. If no port is current then
 * one will be requested to open.
 *
 * @return {Promise<undefined>} A promise that resolves when the port opens.
 */
async function openCurrentPort() {
  port = await getPortToOpen();
  await openPort(port);
}

/**
 * Toggle the open state of the currently selected serial port.
 *
 * @return {Promise<undefined>} A promise that resolves when the port opens or closes.
 */
async function toggleConnectState() {
  try {
    if (isPortOpen()) {
      closePort();
    } else {
      await openCurrentPort();
      await ping();
    }
  }
  catch (ex) {
    console.error('Unable to toggle serial port: ' + ex);
    setPortBannerState(/*openError=*/true);
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

  navigator.serial.addEventListener('connect', onConnect);
  navigator.serial.addEventListener('disconnect', onDisconnect);

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
  console.log(`Selected ${value} = ${deviceState.baudRate}`);
  if (isPortOpen()) {
    await setPortBaud(value);
    await reopenPort();
  }
}

/**
 * Callback when device parity is changed.
 *
 * @param {object} selectObject The HTML select object.
 * @returns {Promise<undefined>} A promise that resolves when the port is
 *          reopened (if previously opened) else immediately.
 */
async function onParitySelected(selectObject) {
  const abbrev = selectObject.value;
  deviceState.parity = parityAbbrevToName[abbrev];
  console.log(`Selected ${abbrev} = ${deviceState.parity}`);
  if (isPortOpen()) {
    await setParity(abbrev);
    await reopenPort();
  }
}

/**
 * Callback when device role is changed.
 *
 * @param {object} selectObject The HTML select object.
 * @returns {Promise<undefined>} A promise that resolves when the device
 *          role has been changed on device (if currently opened) else
 *          immediately.
 */
async function onRoleSelected(selectObject) {
  const abbrev = selectObject.value;
  deviceState.mode = roleAbbrevToName[abbrev];
  console.log(`Selected ${abbrev} = ${deviceState.mode}`);
  if (isPortOpen()) {
    await setRole(abbrev);
  }
}

function onPortSelected(selectObject) {
  const selectedOption = selectObject.selectedOptions[0];
  console.log(`Selected a port: ${selectedOption.port}`);
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
function changeNameCallback() {
  changeNameTimeout = undefined;

  const name = $('aligned-name').value;
  console.log(`Setting device name to "${name}"`);
  setDeviceName(name);
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
function changePinCallback() {
  changePinTimeout = undefined;

  const pin = $('aligned-pin').value;
  console.log(`Setting PIN to "${pin}"`);
  setDevicePin(pin);
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
 *
 * @param {bool} openError true of there was an error opening port.
 */
function setPortBannerState(openError) {
  var toggleConnect = $('toggle-connect');
  var connectBanner = $('connect-banner');
  if (isPortOpen()) {
    toggleConnect.innerText = 'Disconnect';
    connectBanner.classList.remove('disconnected');
    connectBanner.classList.remove('connect-error');
    connectBanner.classList.add('connected');
    $('connect-info').style.visibility = 'hidden';
  } else {
    toggleConnect.innerText = 'Connect';
    connectBanner.classList.remove('connected');
    if (openError) {
      connectBanner.classList.add('connect-error');
      connectBanner.classList.remove('disconnected');
    } else {
      connectBanner.classList.remove('connect-error');
      connectBanner.classList.add('disconnected');
    }
    $('connect-info').style.visibility = 'visible';
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

  setPortBannerState(/*openError=*/ false);

  $('aligned-name').value = deviceState.name;
  $('aligned-pin').value = deviceState.pin;

  const ports = await navigator.serial.getPorts();
  if (ports.length > 0 && !isPortOpen()) {
    $('connection-port-div').style.visibility = 'visible';
  } else {
    $('connection-port-div').style.visibility = 'hidden';
  }
  var all = document.getElementsByClassName('value-info');
  if (deviceUpdated) {
    // UI values reflect state of device.
    for (const element of all) {
      element.style.visibility = 'hidden';
    }
  } else {
    for (const element of all) {
      element.style.visibility = 'visible';
    }
    if (createdDatabase) {
      // UI values are defaults.
      for (const element of all) {
        element.innerText = '(default value)';
      }
    } else {
      // UI values are last saved.
      for (const element of all) {
        element.innerText = '(last written value)';
      }
    }
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
