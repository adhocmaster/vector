import { FastifyInstance } from "fastify";
import  { FastifyRequest, FastifyReply }  from "fastify";

export async function configRoutes(instance: FastifyInstance, options: any, done: CallableFunction) {

    instance.log.info("Registering config routes");

    instance.get('/mnemonic', async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send({ error: 'cannot send mnemonic over internet' })
    });

    instance.post('/mnemonic', async (request: FastifyRequest, reply: FastifyReply) => {
        console.log(request.body)
        reply.send({ body: request.body });
    });


    done();
    
}

// module.exports = configRoutes;

// export {}