import { a } from "./lib/a";
import b from "@app/b";
import "./lib";
export * from "./lib/a.js";
const c = require("./lib/c.cjs");
const d = import("./lib/d");
import fs from "node:fs";
export { a, b, c, d, fs };
