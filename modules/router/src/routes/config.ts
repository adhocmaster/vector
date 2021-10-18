import { FastifyInstance } from "fastify";
import  { FastifyRequest, FastifyReply }  from "fastify";
import { Static, Type } from "@sinclair/typebox";
const fp = require('fastify-plugin')


const MnemonicSchema = Type.Object({
    mnemonic: Type.String()
  });

type MnemonicSchema = Static<typeof MnemonicSchema>;

async function routes(instance: FastifyInstance, options: any, done: CallableFunction) {

    instance.decorateRequest('mnemonic', '');

    instance.log.info("Registering config routes");

    instance.get('/',
                async (request: FastifyRequest, reply: FastifyReply) => {

        reply.send({ error: 'a beautiful form is not yet implemented. call the post api to set mnemonic' })

    });

    instance.post('/mnemonic',
                { schema: { body: MnemonicSchema } },
                async (request: FastifyRequest | any, reply: FastifyReply) => {

        request.log.info( JSON.stringify(request.body) ); // we don't need fast json here.
        const body = request.body as MnemonicSchema;
        const mnemonic = body.mnemonic;
        request.mnemonic = mnemonic;
        // request.log.info(`mnemonic received: ${mnemonic}`);
        // instance.decorate('mnemonic', mnemonic);
        // request.log.info(`closing mnemonic server.`);
        // instance.close();
        reply.send(request.body);


    });


    done();
    
}

// module.exports = fp(configRoutes);
const configRoutes = fp(routes);

export default configRoutes;

// export {}