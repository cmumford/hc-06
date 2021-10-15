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
const kDbName = 'HC-06';
const kDbVersion = 1;
const kDbObjStoreName = 'state';
const kDbPrimaryKeyName = 'id';
const kDbPrimaryKeyValue = 1;

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
  sensitizeControls();
}

function onDisconnect(event) {
  logInfo('Disconnected from serial port.');
  isConnected = false;
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

async function setPortName(name) {
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
    isOpen = true;
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
  port = await navigator.serial.requestPort();
  await openPort();
  await ping();
}

async function disconnectFromPort() {
  closePort();
}

async function readState() {
  try {
    await connectToPort();
    sendAtCommand('');
  } catch (error) {
    logError(`Unexpected failure: ${error}`);
  }
}

async function init() {
  if (!isWebSerialSupported()) {
    console.log('Web Serial not supported.');
    $('web_serial_available').style.display = 'none';
    if (window.isSecureContext == 'https') {
      $('web_serial_none').style.visibility = 'visible';
    } else {
      $('web_serial_insecure').style.visibility = 'visible';
    }
    return;
  }

  // Believe Web Serial API is always avaliable. Confirm and delete this
  // section if so.
  const available = true;
  if (!available) {
    $('web_serial_available').style.display = 'none';
    $('web_serial_unavailable').style.visibility = 'visible';
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

async function setName(element) {
  if (event.key === 'Enter') {
    setPortName(element.value);
  }
}

function sensitizeControls() {
  $('name').disabled = !isPortConnected();
  $('btn_port_open').disabled = isPortOpen();
  $('btn_port_close').disabled = !isPortOpen();

  var all = document.getElementsByClassName('last-saved');
  for (var i = 0; i < all.length; i++) {
    all[i].style.visibility = isPortOpen() ? 'hidden' : 'visible';
  }
}

function setControlValues() {
  const value = parseInt(baudRateToValue(deviceState.baudRate), 16);
  const index = value - 1;
  $('baud').selectedIndex = index;
  $('name').value = deviceState.name;
}