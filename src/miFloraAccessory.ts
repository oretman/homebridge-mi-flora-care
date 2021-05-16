import { API, Logger, CharacteristicValue, AccessoryPlugin, AccessoryConfig } from 'homebridge';
import { Characteristic, Service, Perms, Formats, Units } from 'hap-nodejs';
import os from 'os';
import fakegato from 'fakegato-history';
import MiFlora from 'miflora';

const hostname = os.hostname();

/*
    own characteristics and services
*/

// moisture characteristic
class SoilMoisture extends Characteristic {
    static readonly UUID: string = 'C160D589-9510-4432-BAA6-5D9D77957138';

    constructor() {
      super('SoilMoisture', SoilMoisture.UUID, {
        format: Formats.UINT8,
        unit: Units.PERCENTAGE,
        maxValue: 100,
        minValue: 0,
        minStep: 0.1,
        perms: [Perms.READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
}

// fertility characteristic
class SoilFertility extends Characteristic {
    static readonly UUID: string = '0029260E-B09C-4FD7-9E60-2C60F1250618';

    constructor() {
      super('SoilFertility', SoilFertility.UUID, {
        format: Formats.UINT8,
        maxValue: 10000,
        minValue: 0,
        minStep: 1,
        perms: [Perms.READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
}

// moisture sensor
class PlantSensor extends Service {
    static UUID = '3C233958-B5C4-4218-A0CD-60B8B971AA0A';

    constructor(displayName: string, subtype?: string) {
      super(displayName, PlantSensor.UUID, subtype);
      // Required Characteristics
      this.addCharacteristic(SoilMoisture);
      // Optional Characteristics
      this.addOptionalCharacteristic(Characteristic.CurrentTemperature);
      this.addOptionalCharacteristic(SoilFertility);
    }
}

export class MiFloraCareAccessory implements AccessoryPlugin {
    private readonly Characteristic: typeof Characteristic;

    private readonly informationService: Service;
    private readonly batteryService: Service;
    private readonly lightService: Service;
    private readonly tempService: Service;
    private readonly humidityService: Service;
    private readonly humidityAlertService: Service | null;
    private readonly lowLightAlertService: Service | null;
    private readonly fakeGatoHistoryService: any;
    private readonly plantSensorService: Service;

    private readonly name: string;
    private readonly displayName: string;
    private readonly deviceId: string;
    private storedData: any;
    private interval: number;
    private humidityAlert: boolean;
    private humidityAlertLevel = 0;
    private lowLightAlert: boolean;
    private lowLightAlertLevel = 0;
    private lowBatteryWarningLevel: number;

    private _waitScan: Promise<any> = Promise.resolve();
    private _opts: { duration: number; ignoreUnknown: boolean; addresses: string[] };

    constructor(
        public readonly log: Logger,
        public readonly config: AccessoryConfig,
        public readonly api: API,
    ) {
      this.log = log;
      this.config = config;
      this.api = api;

      // this.Service = this.api.hap.Service;
      this.Characteristic = this.api.hap.Characteristic;

      // extract name from config
      this.name = config.name || 'MiFlora';
      this.displayName = this.name;
      this.deviceId = config.deviceId;
      this.interval = Math.min(Math.max(config.interval, 1), 600);
      this.storedData = {};

      // MiFLora scan input
      this._opts = {
        duration: 15000,
        ignoreUnknown: true,
        addresses: [this.deviceId],
      };

      if (config.humidityAlertLevel != null) {
        this.humidityAlert = true;
        this.humidityAlertLevel = config.humidityAlertLevel;
      } else {
        this.humidityAlert = false;
      }

      if (config.lowLightAlertLevel != null) {
        this.lowLightAlert = true;
        this.lowLightAlertLevel = config.lowLightAlertLevel;
      } else {
        this.lowLightAlert = false;
      }

      if (config.lowBatteryWarningLevel != null && typeof config.lowBatteryWarningLevel === 'number') {
        this.lowBatteryWarningLevel = config.lowBatteryWarningLevel;
      } else {
        this.lowBatteryWarningLevel = 10;
      }

      this.informationService = new this.api.hap.Service.AccessoryInformation();
      this.batteryService = new this.api.hap.Service.Battery(this.name);
      this.lightService = new this.api.hap.Service.LightSensor(this.name);
      this.tempService = new this.api.hap.Service.TemperatureSensor(this.name);
      this.humidityService = new this.api.hap.Service.HumiditySensor(this.name);

      this.humidityAlertService = null;
      if (this.humidityAlert) {
        this.humidityAlertService = new this.api.hap.Service.ContactSensor(this.name + ' Low Humidity', 'humidity');
      }
      this.lowLightAlertService = null;
      if (this.lowLightAlert) {
        this.lowLightAlertService = new this.api.hap.Service.ContactSensor(this.name + ' Low Light', 'light');
      }

      this.plantSensorService = new PlantSensor(this.name);

      this.fakeGatoHistoryService = new fakegato(this.api)('room', this, { storage: 'fs' });

      // Setup services
      this._setUpServices();

      this._refreshInfo();

      setInterval(() => {
        // Start scanning for updates, these will arrive in the corresponding callbacks
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

    private _setUpServices() {
      // info service
      this.informationService
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.config.manufacturer || 'Xiaomi')
        .setCharacteristic(this.api.hap.Characteristic.Model, this.config.model || 'Flower Care')
        .setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.config.serial || hostname + '-' + this.name);
      this.informationService
        .getCharacteristic(this.api.hap.Characteristic.FirmwareRevision)
        .onGet(this.getFirmwareRevision.bind(this));

      this.batteryService
        .getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
        .onGet(this.getBatteryLevel.bind(this));
      this.batteryService
        .setCharacteristic(this.api.hap.Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);
      this.batteryService
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));

      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.CurrentAmbientLightLevel)
        .onGet(this.getCurrentAmbientLightLevel.bind(this));
      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.StatusActive)
        .onGet(this.getStatusActive.bind(this));

      this.tempService
        .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
      this.tempService
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      this.tempService
        .getCharacteristic(this.api.hap.Characteristic.StatusActive)
        .onGet(this.getStatusActive.bind(this));

      this.humidityService
        .getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentMoisture.bind(this));
      this.humidityService
        .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
        .onGet(this.getStatusLowBattery.bind(this));
      this.humidityService
        .getCharacteristic(this.api.hap.Characteristic.StatusActive)
        .onGet(this.getStatusActive.bind(this));

      if (this.humidityAlert && this.humidityAlertService) {
        this.humidityAlertService
          .getCharacteristic(this.api.hap.Characteristic.ContactSensorState)
          .onGet(this.getStatusLowMoisture.bind(this));
        this.humidityAlertService
          .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
          .onGet(this.getStatusLowBattery.bind(this));
        this.humidityAlertService
          .getCharacteristic(this.api.hap.Characteristic.StatusActive)
          .onGet(this.getStatusActive.bind(this));
      }

      if (this.lowLightAlert && this.lowLightAlertService) {
        this.lowLightAlertService
          .getCharacteristic(this.api.hap.Characteristic.ContactSensorState)
          .onGet(this.getStatusLowLight.bind(this));
        this.lowLightAlertService
          .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
          .onGet(this.getStatusLowBattery.bind(this));
        this.lowLightAlertService
          .getCharacteristic(this.api.hap.Characteristic.StatusActive)
          .onGet(this.getStatusActive.bind(this));
      }

      /*
            own characteristics and services
        */
      this.plantSensorService
        .getCharacteristic(SoilMoisture)
        .onGet(this.getCurrentMoisture.bind(this));
      this.plantSensorService.
        getCharacteristic(SoilFertility)
        .onGet(this.getCurrentFertility.bind(this));
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

      this.lightService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, lux);
      this.lightService.updateCharacteristic(Characteristic.StatusActive, true);

      this.tempService.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
      this.tempService.updateCharacteristic(Characteristic.StatusActive, true);

      this.humidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, moisture);
      this.humidityService.updateCharacteristic(Characteristic.StatusActive, true);

      if (this.humidityAlert && this.humidityAlertService) {
        this.humidityAlertService.updateCharacteristic(
          Characteristic.ContactSensorState,
          moisture <= this.humidityAlertLevel ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
        this.humidityAlertService.updateCharacteristic(Characteristic.StatusActive, true);
        this.humidityAlertService.updateCharacteristic(Characteristic.StatusActive, true);
      }

      if (this.lowLightAlert && this.lowLightAlertService) {
        this.lowLightAlertService.updateCharacteristic(
          Characteristic.ContactSensorState,
          lux <= this.lowLightAlertLevel ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
        this.lowLightAlertService.updateCharacteristic(Characteristic.StatusActive, true);
      }
    }

    private _updateFirmware({firmware, battery}) {
      this.log.info('Firmware: %s, Battery level: %s', firmware, battery);
      this.storedData.firmware = {
        firmwareVersion: firmware,
        batteryLevel: battery,
      };

      // Update values
      this.informationService.updateCharacteristic(Characteristic.FirmwareRevision, firmware);

      this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, battery);
      this.batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        battery <= this.lowBatteryWarningLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

      this.lightService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        battery <= this.lowBatteryWarningLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

      this.tempService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        battery <= this.lowBatteryWarningLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

      this.humidityService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        battery <= this.lowBatteryWarningLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

      if (this.humidityAlert && this.humidityAlertService) {
        this.humidityAlertService.updateCharacteristic(
          Characteristic.StatusLowBattery,
          battery <= this.lowBatteryWarningLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      }

      if (this.lowLightAlert && this.lowLightAlertService) {
        this.lowLightAlertService.updateCharacteristic(
          Characteristic.StatusLowBattery,
          battery <= this.lowBatteryWarningLevel ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      }
    }

    private async _scan() {
      this.log.debug('[Flora] Scan ' + this._opts.addresses[0]);
      let resolve;
      const _waitScan = new Promise((_resolve) => {
        resolve = _resolve;
      });
      try {
        const _previousWaitScan = this._waitScan;
        this._waitScan = _waitScan;
        await _previousWaitScan;
        this.log.debug('[Flora] Connect ' + this._opts.addresses[0]);
        return MiFlora.discover(this._opts);
      } finally {
        this.log.debug('[Flora] End ' + this._opts.addresses[0]);
        if (resolve) {
          resolve();
        } else {
          this._waitScan = Promise.resolve();
        }
      }

    }

    private async _refreshInfo() {
      this.log.debug('Mi Flora Care scan...');
      const devices = await this._scan();
      if (devices.length) {
        try {
          const data = await devices[0].query();
          // {
          //     address: 'c4:7c:8d:6b:c9:2f',
          //     type: 'MiFloraMonitor',
          //     firmwareInfo: { battery: 38, firmware: '3.3.1' },
          //     sensorValues: { temperature: 21.8, lux: 0, moisture: 41, fertility: 273 }
          // }
          this._updateData(data.sensorValues);
          this._updateFirmware(data.firmwareInfo);
        } catch (e) {
          this.log.debug(e);
        }
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
        return this.storedData.firmware.batteryLevel <= 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      } else {
        return Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      }
    }

    async getStatusLowMoisture(): Promise<CharacteristicValue> {
      if (this.storedData.data) {
        return this.storedData.data.moisture <= this.humidityAlertLevel ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED;
      } else {
        return Characteristic.ContactSensorState.CONTACT_DETECTED;
      }
    }

    async getStatusLowLight(): Promise<CharacteristicValue> {
      if (this.storedData.data) {
        return this.storedData.data.lux <= this.lowLightAlertLevel ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED;
      } else {
        return Characteristic.ContactSensorState.CONTACT_DETECTED;
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