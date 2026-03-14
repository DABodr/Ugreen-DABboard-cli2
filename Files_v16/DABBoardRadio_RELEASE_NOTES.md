# DABBoardRadio Terminal Radio Software Release Notes

## Version 0.17.2
* Bugfix of stationtext

## Version 0.17.1
* Bugfixes
* Option to use with I2S output

## Version 0.17.0
* Compatibility with Raspberry Pi 5

## Version 0.16.5
* Fixed bug with stationtext

## Version 0.16.4
* Using firmware version DAB 6.0.6
* User interface font now brighter and better readable

## Version 0.16.3
* Added a feature: the station text (e.g. songname) is shown below the list of stations.

## Version 0.16.2
* The DABBoardRadio no longer does a reset if started with the -s option (if the Si468x is already booted
* After starting a new station, the playing frequency index, service id and component id are shown.

## Version 0.16.1
* Added support for the Raspberry Pi Zero W

## Version 0.16
* Added support for the Raspberry Pi 4B

## Version 0.15
* Added a check if the SPI is really available and enabled upon start

## Version 0.11
* Split up Si-library into SPI and Si library
* added Flash SPI library
* Bugfix with empty label
* Terminal startup arguments
* If radio left on, it will not reset anymore when the interface is started again
* Restore old volume level on exit
* Increased menu size
* Firmware is now loaded from flash
* Optimizations: program requires less memory (data format of stationlist changed)
* Get a secret serial number from the flash device, without it it will not load
* Added functions for service type scanning

## Version 0.1
* First Version	2016-07-01


