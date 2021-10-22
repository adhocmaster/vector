
import "core-js/stable";
import "regenerator-runtime/runtime";
import fastify from "fastify";
import pino from "pino";
import { Wallet } from "ethers";
import { ChannelSigner } from "@connext/vector-utils";

import configRoutes from '../routes/config'



export function startConfigServer(config: any, port:number | string, nextJob: (config: any, mnemonic: string) => void): void {

    let mnemonic = "";
    let logger = pino({ name: "Config Service", level: config.logLevel ?? "info" });

    logger.info("Loaded serverConfig from environment");
    const serverConfig = fastify({
        logger,
        pluginTimeout: 300_000,
        disableRequestLogging: config.logLevel !== "debug",
        bodyLimit: 10485760,
    });
    
    
    // register routes
    serverConfig.register(configRoutes);
    

    //  When the server is closed. start next job. 
    serverConfig.addHook("onClose", async (instance: any, done) => {
        if (mnemonic !== ""){
    
        instance.log.info(`mnemonic got onClose: ${mnemonic}`);
        instance.log.info(`Booting router server`);
        
        nextJob(config, mnemonic);
    
        } else {
    
        instance.error.info(`mnemonic got onClose: None`);
    
        }
    })
    

    // check if a valid mnemonic was set in request.
    serverConfig.addHook("onResponse", (request: any, reply) => {
    
        if (request.mnemonic !== "") {
    
        mnemonic = request.mnemonic;
        request.log.info(`mnemonic received: ${request.mnemonic}`);
        try {
    
            const testSigner = new ChannelSigner(Wallet.fromMnemonic(mnemonic).privateKey);
    
        } catch (e) {
    
            console.error(e);
            console.error(`Crashing the server as a signer could not be created with the provided mnemonic: "${mnemonic}"`)
            process.exit(1);
    
        }
    
    
        request.log.info(`closing mnemonic server.`);
        serverConfig.close();
        reply.send(request.body);
    
        }
    
    })
    
    
    serverConfig.listen(port, "0.0.0.0", (err, address) => {
        console.log(`serverConfig will start listening at ${address}`);
        if (err) {
        console.error(err);
        process.exit(1);
        }
        console.log(`serverConfig listening at ${address}`);
    });
    
}
    