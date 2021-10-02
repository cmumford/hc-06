
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
