import type { en } from "./en";

export type Resource = typeof en;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Resource };
  }
}
