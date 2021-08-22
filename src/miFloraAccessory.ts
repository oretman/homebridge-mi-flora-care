import {
  API,
  Logger,
  Service,
  Characteristic,
  CharacteristicValue,
  AccessoryPlugin,
  AccessoryConfig,
} from 'homebridge';
import {PlantSensor, plantSensorService} from './plantSensorService';
import os from 'os';
import fakegato from 'fakegato-history';
import MiFlora from 'miflora';
import {MiFloraDevice} from 'miflora/lib/miflora-device';

const hostname = os.hostname();

export class MiFloraCareAccessory implements AccessoryPlugin {
    private readonly Service: typeof Service;
    private readonly Characteristic: typeof Characteristic;
    private readonly PlantSensor: typeof PlantSensor;

    private readonly informationService: Service;
    private readonly batteryService: Service;
    private readonly lightService: Service;
    private readonly tempService: Service;
    private readonly humidityService: Service;
    private readonly humidityAlertService: Service | null;
    private readonly lowLightAlertService: Service | null;
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    private readonly fakeGatoHistoryService: any;

    private readonly plantSensorService: PlantSensor;

    private readonly name: string;
    private readonly displayName: string;
    private readonly deviceId: string;
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    private storedData: any;
    private interval: number;
    private humidityAlert: boolean;
    private humidityAlertLevel = 0;
    private lowLightAlert: boolean;
    private lowLightAlertLevel = 0;
    private lowBatteryWarningLevel: number;
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    private static _waitScan: Promise<any> = Promise.resolve();
    private _opts: { duration: number; ignoreUnknown: boolean; addresses: string[] };
    private miFloraDevice: MiFloraDevice | undefined;

    constructor(
        public readonly log: Logger,
        public readonly config: AccessoryConfig,
        public readonly api: API,
    ) {
      this.log = log;
      this.config = config;
      this.api = api;

      this.Service = this.api.hap.Service;
      this.Characteristic = this.api.hap.Characteristic;
      this.PlantSensor = plantSensorService(this.api);

      // extract name from config
      this.name = config.name || 'MiFlora';
      this.displayName = this.name;
      this.deviceId = config.deviceId;
      this.interval = typeof config.interval === 'undefined' ? 1800 : config.interval;
      this.storedData = {};

      // MiFLora scan input
      this._opts = {
        duration: 30000, // previous value was 15sec.
        ignoreUnknown: true,
        addresses: [this.deviceId.toLowerCase()],
      };

      if (config.humidityAlertLevel !== null && config.humidityAlertLevel !== undefined) {
        this.humidityAlert = true;
        this.humidityAlertLevel = config.humidityAlertLevel;
      } else {
        this.humidityAlert = false;
      }

      if (config.lowLightAlertLevel !== null && config.lowLightAlertLevel !== undefined) {
        this.lowLightAlert = true;
        this.lowLightAlertLevel = config.lowLightAlertLevel;
      } else {
        this.lowLightAlert = false;
      }

      if (config.lowBatteryWarningLevel !== null
            && config.lowBatteryWarningLevel !== undefined
            && typeof config.lowBatteryWarningLevel === 'number'
      ) {
        this.lowBatteryWarningLevel = config.lowBatteryWarningLevel;
      } else {
        this.lowBatteryWarningLevel = 10;
      }

      // Setup services
      this.informationService = this._createInformationService();
      this.batteryService = this._createBatteryService();
      this.tempService = this._createTemperatureService();
      [this.lightService, this.lowLightAlertService] = this._createLightService();
      [this.humidityService, this.humidityAlertService] = this._createHumidityService();
      this.plantSensorService = this._createPlantService();
      this.fakeGatoHistoryService = this._createFakeGatoHistoryService();

      this.log.debug('First Scan');
      this._refreshInfo();

      setInterval(() => {
        // Start scanning for updates, these will arrive in the corresponding callbacks
        this.log.debug('Interval Scan');
        this._refreshInfo();

      }, this.interval * 1000);
    }

    /*
    * This method is called directly after creation of this instance.
    * It should return all services which should be added to the accessory.
    */
    getServices(): Service[] {
      const services = [
        this.informationService,
        this.batteryService,
        this.lightService,
        this.tempService,
        this.humidityService,
        this.plantSensorService,
        this.fakeGatoHistoryService,
      ];
      if (this.humidityAlert && this.humidityAlertService) {
        services.push(this.humidityAlertService);
      }
      if (this.lowLightAlert && this.lowLightAlertService) {
        services.push(this.lowLightAlertService);
      }
      return services;
    }

    /**
     * own characteristics and services
     *
     * @returns Service
     */
    private _createPlantService(): Service {
      const plantSensorService = new this.PlantSensor(this.name);

      plantSensorService
        .getCharacteristic(this.PlantSensor.SoilMoisture)
        .onGet(this.getCurrentMoisture.bind(this));
      plantSensorService
        .getCharacteristic(this.PlantSensor.SoilFertility)
        .onGet(this.getCurrentFertility.bind(this));

      return plantSensorService;
    }

    private _createInformationService(): Service {

      const informationService = new this.Service.AccessoryInformation();

      informationService
        .setCharacteristic(this.Characteristic.Manufacturer, this.config.manufacturer || 'Xiaomi')
        .setCharacteristic(this.Characteristic.Model, this.config.model || 'Flower Care')
        .setCharacteristic(this.Characteristic.SerialNumber, this.config.serial || hostname + '-' + this.name);
      informationService
        .getCharacteristic(this.Characteristic.FirmwareRevision)
        .onGet(this.getFirmwareRevision.bind(this));

      return informationService;
    }

    private _createBatteryService(): Service {
      const batteryService = new this.Service.Battery(this.name);
      batteryService
        .getCharacteristic(this.Characteristic.BatteryLevel)
        .onGet(this.getBatteryLevel.bind(this));
      batteryService
        .setCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGEABLE);
      batteryService
        .getCharacteristic(this.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));

      return batteryService;
    }

    private _createTemperatureService(): Service {

      const tempService = new this.Service.TemperatureSensor(this.name);

      tempService
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
      tempService
        .getCharacteristic(this.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      tempService
        .getCharacteristic(this.Characteristic.StatusActive)
        .onGet(this.getStatusActive.bind(this));

      return tempService;

    }

    private _createLightService(): Array<Service> {
      const lightService = new this.Service.LightSensor(this.name);

      lightService
        .getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
        .onGet(this.getCurrentAmbientLightLevel.bind(this));
      lightService
        .getCharacteristic(this.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      lightService
        .getCharacteristic(this.Characteristic.StatusActive)
        .onGet(this.getStatusActive.bind(this));


      let lowLightAlertService;
      if (this.lowLightAlert) {
        lowLightAlertService = new this.Service.ContactSensor(this.name + ' Low Light', 'light');
        lowLightAlertService
          .getCharacteristic(this.Characteristic.ContactSensorState)
          .onGet(this.getStatusLowLight.bind(this));
        lowLightAlertService
          .getCharacteristic(this.Characteristic.StatusLowBattery)
          .onGet(this.getStatusLowBattery.bind(this));
        lowLightAlertService
          .getCharacteristic(this.Characteristic.StatusActive)
          .onGet(this.getStatusActive.bind(this));
      } else {
        lowLightAlertService = null;
      }

      return [
        lightService,
        lowLightAlertService,
      ];
    }

    private _createHumidityService(): Array<Service> {
      const humidityService = new this.Service.HumiditySensor(this.name);

      humidityService
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentMoisture.bind(this));
      humidityService
        .getCharacteristic(this.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      humidityService
        .getCharacteristic(this.Characteristic.StatusActive)
        .onGet(this.getStatusActive.bind(this));


      let humidityAlertService;
      if (this.humidityAlert) {
        humidityAlertService = new this.api.hap.Service.ContactSensor(this.name + ' Low Humidity', 'humidity');
        humidityAlertService
          .getCharacteristic(this.Characteristic.ContactSensorState)
          .onGet(this.getStatusLowMoisture.bind(this));
        humidityAlertService
          .getCharacteristic(this.Characteristic.StatusLowBattery)
          .onGet(this.getStatusLowBattery.bind(this));
        humidityAlertService
          .getCharacteristic(this.Characteristic.StatusActive)
          .onGet(this.getStatusActive.bind(this));
      } else {
        humidityAlertService = null;
      }

      return [
        humidityService,
        humidityAlertService,
      ];
    }

    private _createFakeGatoHistoryService(): Service {
      const FakeGatoHistory = fakegato(this.api);
      const fakeGatoHistoryService = new FakeGatoHistory('room', this, {storage: 'fs'});
      return fakeGatoHistoryService;
    }

    private _updateData({temperature, lux, moisture, fertility}) {
      this.log.info('Lux: %s, Temperature: %s, Moisture: %s, Fertility: %s', lux, temperature, moisture, fertility);
      this.storedData.data = {
        temperature,
        lux,
        moisture,
        fertility,
      };

      this.fakeGatoHistoryService.addEntry({
        time: new Date().getTime() / 1000,
        temp: temperature,
        humidity: moisture,
      });

      this.lightService.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, lux);
      this.lightService.updateCharacteristic(this.Characteristic.StatusActive, true);

      this.tempService.updateCharacteristic(this.Characteristic.CurrentTemperature, temperature);
      this.tempService.updateCharacteristic(this.Characteristic.StatusActive, true);

      this.humidityService.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, moisture);
      this.humidityService.updateCharacteristic(this.Characteristic.StatusActive, true);

      if (this.humidityAlert && this.humidityAlertService) {
        const alert = moisture <= this.humidityAlertLevel ?
          this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
          this.Characteristic.ContactSensorState.CONTACT_DETECTED;
        this.humidityAlertService.updateCharacteristic(this.Characteristic.ContactSensorState, alert);
        this.humidityAlertService.updateCharacteristic(this.Characteristic.StatusActive, true);
      }

      if (this.lowLightAlert && this.lowLightAlertService) {
        const alert = lux <= this.lowLightAlertLevel ?
          this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
          this.Characteristic.ContactSensorState.CONTACT_DETECTED;
        this.lowLightAlertService.updateCharacteristic(this.Characteristic.ContactSensorState, alert);
        this.lowLightAlertService.updateCharacteristic(this.Characteristic.StatusActive, true);
      }
    }

    private _updateFirmware({firmware, battery}) {
      this.log.info('Firmware: %s, Battery level: %s', firmware, battery);
      this.storedData.firmware = {
        firmwareVersion: firmware,
        batteryLevel: battery,
      };

      // Update values
      this.informationService.updateCharacteristic(this.Characteristic.FirmwareRevision, firmware);

      const batteryAlert = battery <= this.lowBatteryWarningLevel ?
        this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
        this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

      this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, battery);
      this.batteryService.updateCharacteristic(this.Characteristic.StatusLowBattery, batteryAlert);

      this.lightService.updateCharacteristic(this.Characteristic.StatusLowBattery, batteryAlert);

      this.tempService.updateCharacteristic(this.Characteristic.StatusLowBattery, batteryAlert);

      this.humidityService.updateCharacteristic(this.Characteristic.StatusLowBattery, batteryAlert);

      if (this.humidityAlert && this.humidityAlertService) {
        this.humidityAlertService.updateCharacteristic(this.Characteristic.StatusLowBattery, batteryAlert);
      }

      if (this.lowLightAlert && this.lowLightAlertService) {
        this.lowLightAlertService.updateCharacteristic(this.Characteristic.StatusLowBattery, batteryAlert);
      }
    }

    private _scan(): Promise<Array<MiFloraDevice>> {
      const discover = (address, opts): Promise<Array<MiFloraDevice>> => {
        // try to discover 3 times
        return new Promise((resolve) => {
          setTimeout(async () => {
            try {
              this.log.debug(`Discover Start ${address}`);
              const allDevices: Array<MiFloraDevice> = await MiFlora.discover(opts);
              const devices: Array<MiFloraDevice> = allDevices.filter( device => device.address === address );
              resolve(devices);
            } catch (error) {
              this.log.error(error);
              resolve([]);
            }
            this.log.debug(`Discover End ${address}`);
          }, 10 * 1000); // 10 sec
        });
      };

      const scan = async (address, opts) => {
        try {
          this.log.debug(`Scan Start ${address}`);
          let devices = await discover(address, opts);
          if(devices.length === 0) {
            devices = await discover(address, opts);
          }
          if(devices.length === 0) {
            devices = await discover(address, opts);
          }
          this.log.debug(`Scan Got ${devices.length}`);
          return devices;
        } catch(error) {
          this.log.error(error);
          return [];
        }
      };

      return new Promise((resolveScan) => {
        MiFloraCareAccessory._waitScan = MiFloraCareAccessory._waitScan
          .then( async () => {
            const address = this._opts.addresses[0];
            if (this.miFloraDevice) {
              this.log.debug(`Scan Cache ${address}`);
              resolveScan([this.miFloraDevice]);
            } else {
              const devices = await scan(address, this._opts);
              if(devices.length) {
                this.miFloraDevice = devices[0];
              }
              resolveScan(devices);
            }

            await new Promise( (resolve) => {
              setTimeout( () => {
                resolve(0);
              }, 15 * 1000); // 15 sec;
            });
          });
      });
    }

    private async _refreshInfo() {
      this.log.debug('Mi Flora Care scan...');
      const devices: Array<MiFloraDevice> = await this._scan();
      if (devices.length) {
        try {
          const device: MiFloraDevice = devices[0];
          const data = await device.query();
          // {
          //     address: 'c4:7c:8d:6b:c9:2f',
          //     type: 'MiFloraMonitor',
          //     firmwareInfo: { battery: 38, firmware: '3.3.1' },
          //     sensorValues: { temperature: 21.8, lux: 0, moisture: 41, fertility: 273 }
          // }
          this._updateData(data.sensorValues);
          this._updateFirmware(data.firmwareInfo);
          await device.disconnect();
        } catch (e) {
          this.log.error(e);
        }
      } else {
        this.log.info('No devide found');
      }
    }

    async getFirmwareRevision(): Promise<CharacteristicValue> {
      return this.storedData.firmware ? this.storedData.firmware.firmwareVersion : '0.0.0';
    }

    async getBatteryLevel(): Promise<CharacteristicValue> {
      return this.storedData.firmware ? this.storedData.firmware.batteryLevel : 0;
    }

    async getStatusActive(): Promise<CharacteristicValue> {
      return this.storedData.data ? true : false;
    }

    async getStatusLowBattery(): Promise<CharacteristicValue> {
      if (this.storedData.firmware) {
        return this.storedData.firmware.batteryLevel <= 20 ?
          this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
          this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      } else {
        return this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      }
    }

    async getStatusLowMoisture(): Promise<CharacteristicValue> {
      if (this.storedData.data) {
        return this.storedData.data.moisture <= this.humidityAlertLevel ?
          this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
          this.Characteristic.ContactSensorState.CONTACT_DETECTED;
      } else {
        return this.Characteristic.ContactSensorState.CONTACT_DETECTED;
      }
    }

    async getStatusLowLight(): Promise<CharacteristicValue> {
      if (this.storedData.data) {
        return this.storedData.data.lux <= this.lowLightAlertLevel ?
          this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
          this.Characteristic.ContactSensorState.CONTACT_DETECTED;
      } else {
        return this.Characteristic.ContactSensorState.CONTACT_DETECTED;
      }
    }

    async getCurrentAmbientLightLevel(): Promise<CharacteristicValue> {
      return this.storedData.data ? this.storedData.data.lux : 0;
    }

    async getCurrentTemperature(): Promise<CharacteristicValue> {
      return this.storedData.data ? this.storedData.data.temperature : 0;
    }

    async getCurrentMoisture(): Promise<CharacteristicValue> {
      return this.storedData.data ? this.storedData.data.moisture : 0;
    }

    async getCurrentFertility(): Promise<CharacteristicValue> {
      return this.storedData.data ? this.storedData.data.fertility : 0;
    }

}