import supervisor
import sys

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
                data = input_cmd[3:]
                if data == 'VERSION':
                    sys.stdout.write('LinvorV1.8')
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
                    sys.stdout.write('Unknown msg: "%s"' % data)
            else:
                sys.stdout.write('Unknown cmd: "%s"' % input_cmd)
