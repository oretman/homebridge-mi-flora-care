import { API } from 'homebridge';

import { ACCESSORY_NAME } from './settings';
import { MiFloraCareAccessory } from './miFloraAccessory';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  // api.registerPlatform(PLATFORM_NAME, ExampleHomebridgePlatform);
  api.registerAccessory(ACCESSORY_NAME, MiFloraCareAccessory);
};
