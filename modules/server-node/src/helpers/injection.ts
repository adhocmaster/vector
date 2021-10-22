import "reflect-metadata";
import {container} from "tsyringe";
import pino from "pino";
import {Logger} from "pino";
import { config } from "../config";
import { constructRpcRequest, getPublicIdentifierFromPublicKey, hydrateProviders } from "@connext/vector-utils";
import { Static, Type } from "@sinclair/typebox";
import { Wallet } from "@ethersproject/wallet";


export function registerInstances() {
    registerConfig();
    registerLogger();
}

function registerConfig() {
    container.registerInstance("config", config);
}

function registerLogger() {

    const configuredIdentifier = getPublicIdentifierFromPublicKey(Wallet.fromMnemonic(config.mnemonic).publicKey);

    const logger = pino({ name: configuredIdentifier, level: config.logLevel ?? "info" });
    container.registerInstance("logger", logger);
}

