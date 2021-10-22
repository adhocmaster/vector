import "core-js/stable";
import "regenerator-runtime/runtime";

import { getConfig } from "./config";
import {startRouter} from './runnables';
// import {startConfigServer} from './runnables'; //uncomment this while developing the config server
import {startConfigServer} from '@connext/vector-utils';


const config = getConfig();


const port = config.routerUrl.split(":").pop() ?? 8000;
startConfigServer(config, port, startRouter);
