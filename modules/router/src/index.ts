import "core-js/stable";
import "regenerator-runtime/runtime";

import { getConfig } from "./config";
import {startConfigServer, startRouter} from './runnables';

const config = getConfig();


const port = config.routerUrl.split(":").pop() ?? 8000;
startConfigServer(config, port, startRouter);
