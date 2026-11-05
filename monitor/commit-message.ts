/** Prints the commit subject for the latest run. Used by the daily workflow. */
import path from "node:path";
import { StatusFile } from "../lib/schema.ts";
import { DATA_DIR } from "./config.ts";
import { commitSubject } from "./score.ts";
import { readJson } from "./util.ts";

const status = await readJson(path.join(DATA_DIR, "status.json"), StatusFile);
console.log(commitSubject(status.generatedAt.slice(0, 10), status.integrations));
