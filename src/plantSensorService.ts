import { API, Formats, Perms, Service, Characteristic, Units } from 'homebridge';

export declare class SoilCharacteristic extends Characteristic {
    static readonly UUID: string;
    constructor();
}

export declare class PlantSensor extends Service {
    static readonly UUID: string;
    static SoilMoisture: typeof SoilCharacteristic;
    static SoilFertility: typeof SoilCharacteristic;
    constructor(displayName: string, subtype?: string);
}

export const plantSensorService = (api: API): typeof PlantSensor => {

  const Service = api.hap.Service;
  const Characteristic = api.hap.Characteristic;

  class SoilMoisture extends Characteristic {
        static readonly UUID: string = 'C160D589-9510-4432-BAA6-5D9D77957138';

        constructor() {
          super('SoilMoisture', SoilMoisture.UUID, {
            format: Formats.UINT8,
            unit: Units.PERCENTAGE,
            maxValue: 100,
            minValue: 0,
            minStep: 0.1,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
          });
          this.value = this.getDefaultValue();
        }
  }

  // fertility characteristic
  class SoilFertility extends Characteristic {
        static readonly UUID: string = '0029260E-B09C-4FD7-9E60-2C60F1250618';

        constructor() {
          super('SoilFertility', SoilFertility.UUID, {
            format: Formats.UINT16,
            maxValue: 10000,
            minValue: 0,
            minStep: 1,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
          });
          this.value = this.getDefaultValue();
        }
  }

  // moisture sensor
  class PlantSensor extends Service {
        static readonly UUID = '3C233958-B5C4-4218-A0CD-60B8B971AA0A';
        static readonly SoilMoisture: typeof SoilCharacteristic = SoilMoisture;
        static readonly SoilFertility: typeof SoilCharacteristic = SoilFertility;

        constructor(displayName: string, subtype?: string) {
          super(displayName, PlantSensor.UUID, subtype);
          // Required Characteristics
          this.addCharacteristic(PlantSensor.SoilMoisture);
          // Optional Characteristics
          this.addOptionalCharacteristic(Characteristic.CurrentTemperature);
          this.addOptionalCharacteristic(PlantSensor.SoilFertility);
        }
  }

  return PlantSensor;
};
