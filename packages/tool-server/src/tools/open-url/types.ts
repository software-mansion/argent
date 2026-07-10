export interface OpenUrlParams {
  udid: string;
  url: string;
}

export interface OpenUrlResult {
  opened: boolean;
  url: string;
}

export interface OpenUrlServices {
  physicalIos?: PhysicalIosAutomationApi;
}
import type { PhysicalIosAutomationApi } from "../../blueprints/physical-ios-automation";
