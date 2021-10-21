var deviceState = {
  baudRate: 9600,  // bps.
  parity: 'none',  // 'none', 'even', or 'odd.
  name: 'HC-06',   // Device's Bluetooth name.
  pin: '1234',     // four digit number.
  mode: 'master'   // 'master' or 'slave'.
};
var port;
var usbProductId = null;
var usbVendorId = null;
var isConnected = false;
var isOpen = false;
var deviceStateDb;
var createdDatabase =
    false;  // There was no settings db at page load and was created.
var deviceUpdated =
    false;  // The settings were written (at least once) to device.
var nameChangeTimer;
const kDbName = 'HC-06';
const kDbVersion = 1;
const kDbObjStoreName = 'state';
const kDbPrimaryKeyName = 'id';
const kDbPrimaryKeyValue = 1;
const parityAbbrevToName = {};  // Abbrev ("PO", etc.) to name ("odd", etc.).
const roleAbbrevToName = {};  // Abbrev ("M", "S") to name ("master", "slave");
const baudAbbrevToName = {};  // Abbrev ("1", "2") to name ("1200", "2400");

function $(id) {
  return document.getElementById(id);
}

function dictReverseLookup(dict, value) {
  foundValue = undefined;
  Object.entries(dict).forEach(([k, v]) => {
    if (value == v) {
      foundValue = k;
    }
  });
  return foundValue;
}

function logStatus(msg) {
  const status = $('status');
  const br = document.createElement('br');
  const text = document.createTextNode(msg);
  status.appendChild(br);
  status.appendChild(text);
}

function logInfo(msg) {
  logStatus(msg);
  console.log(msg);
}

function logError(msg) {
  logStatus(msg);
  console.error(msg);
}

function isWebSerialSupported() {
  return 'serial' in navigator;
}

// Write the current device state to the database.
function getDbData(db) {
  var transaction = db.transaction([kDbObjStoreName], 'readwrite');
  transaction.oncomplete = (event) => {
    setControlValues();
  };
  transaction.onerror = (event) => {
    logError(`Get transaction error: ${event.target.errorCode}`);
  };
  var store = transaction.objectStore(kDbObjStoreName);
  var request = store.get(kDbPrimaryKeyValue);
  request.onsuccess = (event) => {
    deviceState = request.result;
    sensitizeControls();
  };
}

// Read the current device state from the database.
function putDbData(db) {
  var transaction = db.transaction([kDbObjStoreName], 'readwrite');
  transaction.oncomplete = (event) => {};
  transaction.onerror = (event) => {
    logError(`Put transaction error: ${event.target.errorCode}`);
  };
  var store = transaction.objectStore(kDbObjStoreName);
  var request = store.put(deviceState, kDbPrimaryKeyValue);
  request.onsuccess = (event) => {};
}

// Open the device state database and read the saved device state.
function loadSavedDeviceState() {
  var dbOpenRequest = window.indexedDB.open(kDbName, kDbVersion);
  dbOpenRequest.onerror = (event) => {
    logError(`Error opening device db, err: ${event.target.errorCode}`);
  };
  dbOpenRequest.onsuccess = async (event) => {
    deviceStateDb = event.target.result;
    getDbData(event.target.result);
  };
  dbOpenRequest.onupgradeneeded = (event) => {
    logInfo('Created device state database.');
    createdDatabase = true;
    var db = event.target.result;
    var objectStore = db.createObjectStore(kDbObjStoreName);
    objectStore.transaction.oncomplete = (event) => {
      putDbData(db);
    };
  };
}

function isPortOpen() {
  return isOpen;
}

function isPortConnected() {
  return isConnected;
}

function onConnect(event) {
  logInfo('Connected to serial port.');
  isConnected = true;
  deviceUpdated = false;
  sensitizeControls();
}

function onDisconnect(event) {
  logInfo('Disconnected from serial port.');
  isConnected = false;
  deviceUpdated = false;
  sensitizeControls();
}

async function sendAtCommand(payload) {
  if (!isPortConnected()) {
    throw Error('Port not connected.');
  }
  const write_string = payload ? 'AT' + payload : 'AT';
  const writer = port.writable.getWriter();
  await writer.write(new TextEncoder().encode(write_string));
  writer.releaseLock();

  // Read response.
  reader = port.readable.getReader();
  const {value, done} = await reader.read();
  reader.releaseLock();
  if (done) {
    logInfo('Port is closed');
    isConnected = false;
    deviceUpdated = false;
    isOpen = false;
    sensitizeControls();
    return null;
  }

  const response = new TextDecoder().decode(value);
  return response;
}

async function setPortBaud(baudValue) {
  const response = await sendAtCommand(`+BAUD${baudValue}`);
  putDbData(deviceStateDb);
}

// Set the parity to the parity abbreviation (PN, PO, PE).
async function setParity(parityAbbrev) {
  const response = await sendAtCommand(`+${parityAbbrev}`);
  putDbData(deviceStateDb);
}

// Set the role to the role abbreviation ("M" or "S").
async function setRole(role) {
  const response = await sendAtCommand(`+ROLE=${role}`);
  putDbData(deviceStateDb);
}

async function setDeviceName(name) {
  if (name.length > 20) {
    throw Error('Name too long: 20 chars max');
  }
  logInfo(`Setting name to "${name}"`)
  const response = await sendAtCommand(`+NAME${name}`);
  deviceState.name = name;
  putDbData(deviceStateDb);
}

async function setPinName(pin) {
  if (pin.length != 4) {
    throw Error('PIN length must be 4 characters');
  }
  logInfo(`Setting PIN to "${PIN}"`)
  const response = await sendAtCommand(`+PIN${pin}`);
  deviceState.pin = pin;
  putDbData(deviceStateDb);
}

async function ping() {
  const response = await sendAtCommand();
  logInfo(`Ping response: "${response}"`);
}

async function closePort() {
  try {
    isConnected = false;
    isOpen = false;
    deviceUpdated = false;
    await port.close();
  } finally {
    sensitizeControls();
  }
}

async function openPort() {
  logInfo(`Opening port baud: ${deviceState.baudRate}`);
  try {
    await port.open({
      baudRate: deviceState.baudRate,
      parity: 'none',
      dataBits: 8,
      stopBits: 1,
      flowControl: 'none'
    });
    isConnected = true;
    deviceUpdated = false;
    isOpen = true;
    putDbData(deviceStateDb);
  } finally {
    sensitizeControls();
  }
}

async function reopenPort() {
  if (isPortOpen()) {
    await closePort();
  }
  openPort();
}

async function connectToPort() {
  try {
    const ports = await navigator.serial.getPorts();
    console.log(ports);

    port = await navigator.serial.requestPort();
    const portInfo = await port.getInfo();
    usbProductId = portInfo.usbProductId;
    usbVendorId = portInfo.usbVendorId;
    await openPort();
    await ping();
    populatePortMenu();
  } catch (e) {
    setPortBannerState(/*openError=*/ true);
  }
}

function toggleConnectState() {
  if (isPortConnected()) {
    closePort();
  } else {
    readState();
  }
}

async function readState() {
  try {
    await connectToPort();
    if (isPortConnected())
      await sendAtCommand('');
    else
      logInfo('Did not connect');
  } catch (error) {
    logError(`Unexpected failure: ${error}`);
  }
}

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

  sensitizeControls();

  navigator.serial.addEventListener('connect', onConnect);
  navigator.serial.addEventListener('disconnect', onDisconnect);

  loadSavedDeviceState();
  populatePortMenu();
}

async function onBaudSelected(selectObject) {
  const value = selectObject.value;
  deviceState.baudRate = baudAbbrevToName[value];
  logInfo(`Selected ${value} = ${deviceState.baudRate}`);
  if (isPortConnected()) {
    await setPortBaud(value);
    await reopenPort();
  }
}

async function onParitySelected(selectObject) {
  const abbrev = selectObject.value;
  deviceState.parity = parityAbbrevToName[abbrev];
  logInfo(`Selected ${abbrev} = ${deviceState.parity}`);
  if (isPortConnected()) {
    await setParity(abbrev);
    await reopenPort();
  }
}

async function onRoleSelected(selectObject) {
  const abbrev = selectObject.value;
  deviceState.mode = roleAbbrevToName[abbrev];
  logInfo(`Selected ${abbrev} = ${deviceState.mode}`);
  if (isPortConnected()) {
    await setRole(abbrev);
  }
}

function onPortSelected(selectedObject) {
  logInfo('Selected a port.');
}

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

  var option;
  const ports = await navigator.serial.getPorts();
  ports.forEach(port => {
    console.log(port);
    option = document.createElement('option');
    const portInfo = port.getInfo();
    option.text = `${portInfo.usbVendorId}/${portInfo.usbProductId}`;
    portMenu.add(option);
  });

  option = document.createElement('option');
  option.text = 'New';
  portMenu.add(option);
}

function changeNameCallback() {
  nameChangeTimer = undefined;

  const name = $('aligned-name').value;
  logInfo(`Setting device name to "${name}"`);
  setDeviceName(name);
}

function onNameChanged(element) {
  if (nameChangeTimer) {
    window.clearTimeout(nameChangeTimer);
    nameChangeTimer = undefined;
  }
  nameChangeTimer =
      window.setTimeout(changeNameCallback, /*milliseconds=*/ 500);
}

function changePinCallback() {
  pinChangeTimer = undefined;

  const pin = $('aligned-pin').value;
  logInfo(`Setting PIN to "${pin}"`);
  setDevicePin(pin);
}

function startPinChangeTimer(element) {
  if (pinChangeTimer) {
    window.clearTimeout(pinChangeTimer);
    pinChangeTimer = undefined;
  }
  pinChangeTimer = window.setTimeout(changePinCallback, /*milliseconds=*/ 500);
}

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

function sensitizeControls() {
  $('aligned-name').disabled = !isPortConnected();
  $('aligned-pin').disabled = !isPortConnected();
  $('aligned-role').disabled = !isPortConnected();

  setPortBannerState(/*openError=*/ false);

  $('aligned-name').value = deviceState.name;
  $('aligned-pin').value = deviceState.pin;

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

function setControlValues() {
  const value =
      parseInt(dictReverseLookup(baudAbbrevToName, deviceState.baudRate), 16);
  const index = value - 1;
  $('aligned-baud').selectedIndex = index;
}
