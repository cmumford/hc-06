import supervisor
import sys

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
                message = input_cmd[3:]
                if message == 'VERSION':
                    sys.stdout.write(' LinvorV1.8')
                elif message.startswith('BAUD'):
                    sys.stdout.write('OK1200')
                elif message.startswith('NAME'):
                    sys.stdout.write('OKname')
                elif message.startswith('PIN'):
                    sys.stdout.write('OKsetpin')
                elif message in ('PE', 'PO', 'PN'):
                    sys.stdout.write('OK ODD')
                else:
                    sys.stdout.write('Unknown msg: "%s"' % message)
            else:
                sys.stdout.write('Unknown: "%s"' % input_cmd)
