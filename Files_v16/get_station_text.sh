#!/usr/bin/env python3

# call this with sudo!!

import subprocess
import json

while 1:
    x = subprocess.Popen(["./radio_cli", "-D", "-j"], stdout=subprocess.PIPE)
    output = x.communicate()
    output_str = output[0].decode("ISO-8859-1")
    output_json = json.loads(output_str)

    if 'stationText' in output_json:
        station_text = output_json['stationText']
        if station_text != 'not loaded':
            print(station_text)

