var deviceState = {
  baudRate: 9600,  // bps.
  parity: 'none',  // 'none', 'even', or 'odd.
  name: 'HC-06',   // Device's Bluetooth name.
  pin: '1234',     // four digit number.
  mode: 'master'   // 'master' or 'slave'.
};
var port;
var isConnected = false;
var isOpen = false;
var deviceStateDb;
var createdDatabase = false; // There was no settings db at page load and was created.
var deviceUpdated = false;  // The settings were written (at least once) to device.
var nameChangeTimer;
const kDbName = 'HC-06';
const kDbVersion = 1;
const kDbObjStoreName = 'state';
const kDbPrimaryKeyName = 'id';
const kDbPrimaryKeyValue = 1;

function $(id) {
  return document.getElementById(id);
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
  transaction.oncomplete = (event) => { };
  transaction.onerror = (event) => {
    logError(`Put transaction error: ${event.target.errorCode}`);
  };
  var store = transaction.objectStore(kDbObjStoreName);
  var request = store.put(deviceState, kDbPrimaryKeyValue);
  request.onsuccess = (event) => { };
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
  const { value, done } = await reader.read();
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

async function setDeviceName(name) {
  if (name.length > 20) {
    throw Error('Name too long: 20 chars max');
  }
  logInfo(`Setting name to "${name}"`)
  const response = await sendAtCommand(`+NAME${name}`);
  deviceState.name = name;
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
    port = await navigator.serial.requestPort();
    await openPort();
    await ping();
  } catch (e) {
    setPortBannerState(/*openError=*/true);
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
}

function baudRateToValue(rate) {
  switch (rate) {
    case 1200:
      return '1';
    case 2400:
      return '2';
    case 4800:
      return '3';
    case 9600:
      return '4';
    case 19200:
      return '5';
    case 38400:
      return '6';
    case 57600:
      return '7';
    case 115200:
      return '8';
    case 230400:
      return '9';
    case 460800:
      return 'A';
    case 921600:
      return 'B';
    case 1382400:
      return 'C';
    default:
      return '4';
  }
}

function baudValueToRate(value) {
  switch (value) {
    case '1':
      return 1200;
    case '2':
      return 2400;
    case '3':
      return 4800;
    case '4':
      return 9600;
    case '5':
      return 19200;
    case '6':
      return 38400;
    case '7':
      return 57600;
    case '8':
      return 115200;
    case '9':
      return 230400;
    case 'A':
      return 460800;
    case 'B':
      return 921600;
    case 'C':
      return 1382400;
  }
}

async function baudSelected(selectObject) {
  const value = selectObject.value;
  deviceState.baudRate = baudValueToRate(value);
  logInfo(`Selected ${value} = ${deviceState.baudRate}`);
  if (isPortConnected()) {
    await setPortBaud(value);
    await reopenPort();
  }
}

function changeNameCallback() {
  nameChangeTimer = undefined;

  const name = $('aligned-name').value;
  logInfo(`Setting device name to "${name}"`);
  setDeviceName(name);
}

function startNameChangeTimer(element) {
  if (nameChangeTimer) {
    window.clearTimeout(nameChangeTimer);
    nameChangeTimer = undefined;
  }
  nameChangeTimer =
    window.setTimeout(changeNameCallback, /*milliseconds=*/ 500);
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

  setPortBannerState(/*openError=*/false);

  $('aligned-name').value = deviceState.name;

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
  const value = parseInt(baudRateToValue(deviceState.baudRate), 16);
  const index = value - 1;
  $('aligned-baud').selectedIndex = index;
}
