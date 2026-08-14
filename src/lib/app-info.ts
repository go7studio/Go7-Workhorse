import pkg from "../../package.json";

export const APP_VERSION = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
