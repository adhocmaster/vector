import "reflect-metadata";
import { container, inject} from "tsyringe";
import pino from "pino";
import {Logger} from "pino";
import { config } from "../config";
import { constructRpcRequest, getPublicIdentifierFromPublicKey, hydrateProviders } from "@connext/vector-utils";
import { Static, Type } from "@sinclair/typebox";
import { Wallet } from "@ethersproject/wallet";
import { PrismaStore } from "../services/store";
import { HydratedProviders } from "@connext/vector-types";


export function registerInstances() {
    registerConfig();
    registerLogger();
    const config = container.resolve<any>("config");
    const logger = container.resolve<Logger>("logger");

    registerPrisma(logger);
    registerHydratedProviders(logger, config);

    
}

function registerConfig() {
    container.registerInstance("config", config);
}

function registerLogger() {

    const configuredIdentifier = getPublicIdentifierFromPublicKey(Wallet.fromMnemonic(config.mnemonic).publicKey);

    const logger = pino({ name: configuredIdentifier, level: config.logLevel ?? "info" });
    container.registerInstance<Logger>("logger", logger);
}


function registerPrisma(logger: Logger) {

    logger.info("Creating PrismaStore");
    const store = new PrismaStore();
    container.registerInstance<PrismaStore>("store", store);

}


function registerHydratedProviders(logger: Logger, config: any) {

    logger.info("hydrateProviders");
    const _providers = hydrateProviders(config.chainProviders);
    container.registerInstance<HydratedProviders>("_providers", _providers);
    container.registerInstance<HydratedProviders>("hydrated_chain_providers", _providers);
}
