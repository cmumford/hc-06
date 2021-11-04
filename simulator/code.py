import supervisor
import sys

# This is a very basic simulator for the HC-06. It runs
# on CircuitPython (https://circuitpython.org/). It only
# attempts to respond to the AT commands the same as the
# HC-06. It does not do anywithing with Bluetooth.
#
# Note: This app will accept inbound connection with any
# baud and parity.

bauds = {
    '1': '1200',
    '2': '2400',
    '3': '4800',
    '4': '9600',
    '5': '19200',
    '6': '38400',
    '7': '57600',
    '8': '115200',
    '9': '230400',
    'A': '460800',
    'B': '921600',
    'C': '1382400'
}

parities = {
    'PO': 'ODD',
    'PE': 'EVEN',
    'PN': 'NONE',
}

roles = {
    'S': 'SLAVE',
    'M': 'MASTER',
}

# See datasheet:
# https://drive.google.com/file/d/0B4urklB65vaCN1pSdHZQTjFPZzQ/view
# for explanation of AT commands.
#
# Note: There are at least two different versions of the HC-06
#       currently in production. They do respond slightly differently
#       to the AT commands.
def HandleCommandData(data):
    if data == 'VERSION':
        sys.stdout.write('HC06SimV1.0')
    elif data.startswith('BAUD'):
        baud = data[4:]
        if baud in bauds:
            sys.stdout.write('OK%s' % bauds[baud])
        else:
            sys.stdout.write("Unknown baud: '%s'" % baud)
    elif data.startswith('NAME'):
        sys.stdout.write('OKname')
    elif data.startswith('PIN'):
        sys.stdout.write('OKsetpin')
    elif data.startswith('ROLE='):
        mode = data[5:]
        if mode in roles:
            sys.stdout.write('OK+ROLE:%s' % mode)
        else:
            sys.stdout.write('Bad ROLE: "%s"' % mode)
    elif data in parities:
        sys.stdout.write('OK %s' % parities[data])
    else:
        sys.stdout.write('Unknown data: "%s"' % data)

while True:
    input_chars = []
    while supervisor.runtime.serial_bytes_available:
        input_str = sys.stdin.read(1)
        input_chars.append(input_str)
    if len(input_chars):
        input_cmd = ''.join(input_chars)
        if input_cmd == 'AT':
            sys.stdout.write('OK')
        else:
            if input_cmd.startswith('AT+'):
                HandleCommandData(input_cmd[3:])
            else:
                sys.stdout.write('Unknown cmd: "%s"' % input_cmd)
