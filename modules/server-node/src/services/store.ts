import {
  FullChannelState,
  Balance,
  CreateUpdateDetails,
  DepositUpdateDetails,
  ResolveUpdateDetails,
  SetupUpdateDetails,
  FullTransferState,
  UpdateType,
  EngineEvent,
  IServerNodeStore,
  WithdrawCommitmentJson,
  StoredTransaction,
  TransactionReason,
  StoredTransactionStatus,
  ChannelDispute,
  TransferDispute,
  GetTransfersFilterOpts,
  StoredTransactionAttempt,
  StoredTransactionReceipt,
  ChannelUpdate,
} from "@connext/vector-types";
import { getRandomBytes32, getSignerAddressFromPublicIdentifier, mkSig } from "@connext/vector-utils";
import { BigNumber } from "@ethersproject/bignumber";
import { TransactionResponse, TransactionReceipt } from "@ethersproject/providers";
// import { logger } from "..";

// import { config } from "../config";
import {
  Prisma,
  Channel,
  PrismaClient,
  Update,
  Balance as BalanceEntity,
  Transfer,
  OnchainTransaction,
  ChannelDispute as ChannelDisputeEntity,
  TransferDispute as TransferDisputeEntity,
  OnchainTransactionReceipt,
  OnchainTransactionAttempt,
  PrismaPromise,
} from "../generated/db-client";

import { injectable, inject } from "tsyringe";
import { Logger } from "pino";

// const config = container.resolve<any>("config");
// const logger = container.resolve<Logger>("logger"); 

const convertOnchainTransactionEntityToTransaction = (
  onchainEntity: OnchainTransaction & {
    channel: Channel;
    receipt: OnchainTransactionReceipt | null;
    attempts: OnchainTransactionAttempt[];
  },
): StoredTransaction => {
  // NOTE: There will always be a 'latestAttempt' in the OnchainTransaction, as it is created only when
  // the first attempt is made. This array here will also have been sorted by createdBy Date.
  const receipt = onchainEntity.receipt;
  return {
    attempts: onchainEntity.attempts.map((a) => {
      return {
        gasLimit: a.gasLimit,
        gasPrice: a.gasPrice,
        createdAt: a.createdAt,
        transactionHash: a.transactionHash,
      } as StoredTransactionAttempt;
    }),
    chainId: parseInt(onchainEntity.chainId!),
    channelAddress: onchainEntity.channelAddress,
    data: onchainEntity.data!,
    from: onchainEntity.from!,
    id: onchainEntity.id,
    nonce: onchainEntity.nonce!,
    reason: onchainEntity.reason as TransactionReason,
    status: onchainEntity.status as StoredTransactionStatus,
    to: onchainEntity.to!,
    value: onchainEntity.value!,
    error: onchainEntity.error ?? undefined,
    receipt: receipt
      ? ({
          blockHash: receipt.blockHash!,
          blockNumber: receipt.blockNumber!,
          contractAddress: receipt.contractAddress!,
          cumulativeGasUsed: receipt.cumulativeGasUsed!,
          gasUsed: receipt.gasUsed!,
          logsBloom: receipt.logsBloom!,
          transactionHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex!,
          byzantium: receipt.byzantium!,
          logs: receipt.logs ?? undefined,
          root: receipt.root ?? undefined,
          status: receipt.status ?? undefined,
        } as StoredTransactionReceipt)
      : undefined,
  };
};

const convertUpdateEntityToChannelUpdate = (entity: Update & { channel: Channel | null }): ChannelUpdate => {
  let details: SetupUpdateDetails | DepositUpdateDetails | CreateUpdateDetails | ResolveUpdateDetails | undefined;
  switch (entity.type) {
    case "setup":
      details = {
        networkContext: {
          chainId: BigNumber.from(entity.channel!.chainId).toNumber(),
          channelFactoryAddress: entity.channel!.channelFactoryAddress,
          transferRegistryAddress: entity.channel!.transferRegistryAddress,
        },
        timeout: entity.channel!.timeout,
      } as SetupUpdateDetails;
      break;
    case "deposit":
      details = {
        totalDepositsAlice: entity.totalDepositsAlice,
        totalDepositsBob: entity.totalDepositsBob,
      } as DepositUpdateDetails;
      break;
    case "create":
      details = {
        balance: {
          to: [entity.transferToA!, entity.transferToB!],
          amount: [entity.transferAmountA!, entity.transferAmountB!],
        },
        merkleRoot: entity.merkleRoot!,
        transferDefinition: entity.transferDefinition!,
        transferTimeout: entity.transferTimeout!,
        transferId: entity.transferId!,
        transferEncodings: entity.transferEncodings!.split("$"),
        transferInitialState: JSON.parse(entity.transferInitialState!),
        meta: entity.meta ? JSON.parse(entity.meta) : undefined,
      } as CreateUpdateDetails;
      break;
    case "resolve":
      details = {
        merkleRoot: entity.merkleRoot!,
        transferDefinition: entity.transferDefinition!,
        transferId: entity.transferId!,
        transferResolver: JSON.parse(entity.transferResolver!),
        meta: entity.meta ? JSON.parse(entity.meta) : undefined,
      } as ResolveUpdateDetails;
      break;
  }
  return {
    id: {
      id: entity.id!,
      signature: entity.idSignature!,
    },
    assetId: entity.assetId,
    balance: {
      amount: [entity.amountA, entity.amountB],
      to: [entity.toA, entity.toB],
    },
    channelAddress: entity.channelAddressId,
    details,
    fromIdentifier: entity.fromIdentifier,
    nonce: entity.nonce,
    aliceSignature: entity.signatureA ?? undefined,
    bobSignature: entity.signatureB ?? undefined,
    toIdentifier: entity.toIdentifier,
    type: entity.type as keyof typeof UpdateType,
  };
};

const convertChannelEntityToFullChannelState = (
  channelEntity: Channel & {
    balances: BalanceEntity[];
    latestUpdate: Update | null;
    dispute: ChannelDisputeEntity | null;
  },
): FullChannelState => {
  // use the inputted assetIds to preserve order
  const assetIds = channelEntity?.assetIds ? channelEntity.assetIds.split(",") : [];

  // get balances and locked value for each assetId
  const processedDepositsA: string[] = [];
  const processedDepositsB: string[] = [];
  const defundNonces: string[] = [];
  const balances: Balance[] = assetIds.map((assetId) => {
    const balanceA = channelEntity.balances.find(
      (bal) => bal.assetId === assetId && bal.participant === channelEntity.participantA,
    );
    processedDepositsA.push(balanceA?.processedDeposit ?? "0");
    const balanceB = channelEntity.balances.find(
      (bal) => bal.assetId === assetId && bal.participant === channelEntity.participantB,
    );
    defundNonces.push(balanceA?.defundNonce ?? "1");
    processedDepositsB.push(balanceB?.processedDeposit ?? "0");
    return {
      amount: [balanceA?.amount ?? "0", balanceB?.amount ?? "0"],
      to: [balanceA?.to ?? channelEntity.participantA, balanceB?.to ?? channelEntity.participantB],
    };
  });

  // convert db representation into details for the particular update
  const latestUpdate = !!channelEntity.latestUpdate
    ? convertUpdateEntityToChannelUpdate({ ...channelEntity.latestUpdate, channel: channelEntity })
    : undefined;

  const channel: FullChannelState = {
    assetIds,
    balances,
    channelAddress: channelEntity.channelAddress,
    merkleRoot: channelEntity.merkleRoot,
    processedDepositsA,
    processedDepositsB,
    defundNonces,
    networkContext: {
      chainId: BigNumber.from(channelEntity.chainId).toNumber(),
      channelFactoryAddress: channelEntity.channelFactoryAddress,
      transferRegistryAddress: channelEntity.transferRegistryAddress,
    },
    nonce: channelEntity.nonce,
    alice: channelEntity.participantA,
    aliceIdentifier: channelEntity.publicIdentifierA,
    bob: channelEntity.participantB,
    bobIdentifier: channelEntity.publicIdentifierB,
    timeout: channelEntity.timeout,
    latestUpdate: latestUpdate as any,
    inDispute: !!channelEntity.dispute,
  };
  return channel;
};

const convertTransferEntityToFullTransferState = (
  transfer: Transfer & {
    channel: Channel | null;
    createUpdate: Update | null;
    resolveUpdate: Update | null;
    dispute: TransferDisputeEntity | null;
  },
) => {
  const fullTransfer: FullTransferState = {
    inDispute: !!transfer.dispute,
    channelFactoryAddress: transfer.channel!.channelFactoryAddress,
    assetId: transfer.createUpdate!.assetId,
    chainId: BigNumber.from(transfer.channel!.chainId).toNumber(),
    channelAddress: transfer.channel!.channelAddress!,
    balance: {
      amount: [transfer.amountA, transfer.amountB],
      to: [transfer.toA, transfer.toB],
    },
    initiator:
      transfer.createUpdate!.fromIdentifier === transfer.channel?.publicIdentifierA
        ? transfer.channel!.participantA
        : transfer.channel!.participantB,
    responder:
      transfer.createUpdate!.toIdentifier === transfer.channel?.publicIdentifierA
        ? transfer.channel!.participantA
        : transfer.channel!.participantB,
    initialStateHash: transfer.initialStateHash,
    transferDefinition: transfer.createUpdate!.transferDefinition!,
    initiatorIdentifier: transfer.createUpdate!.fromIdentifier,
    responderIdentifier: transfer.createUpdate!.toIdentifier,
    channelNonce: transfer!.channelNonce,
    transferEncodings: transfer.createUpdate!.transferEncodings!.split("$"),
    transferId: transfer.createUpdate!.transferId!,
    transferState: {
      balance: {
        amount: [transfer.createUpdate!.transferAmountA!, transfer.createUpdate!.transferAmountB],
        to: [transfer.createUpdate!.transferToA, transfer.createUpdate!.transferToB],
      },
      ...JSON.parse(transfer.createUpdate!.transferInitialState!),
    },
    transferTimeout: transfer.createUpdate!.transferTimeout!,
    meta: transfer.createUpdate!.meta ? JSON.parse(transfer.createUpdate!.meta) : undefined,
    transferResolver: transfer.resolveUpdate?.transferResolver
      ? JSON.parse(transfer.resolveUpdate?.transferResolver)
      : undefined,
  };
  return fullTransfer;
};

const convertEntitiesToWithdrawalCommitment = (
  resolveEntity: Update | null,
  createEntity: Update,
  channel: Channel,
  transactionHash?: string,
): WithdrawCommitmentJson => {
  const initialState = JSON.parse(createEntity.transferInitialState ?? "{}");
  const resolver = JSON.parse(resolveEntity?.transferResolver ?? "{}");
  const resolveMeta = JSON.parse(resolveEntity?.meta ?? "{}");

  const aliceIsInitiator = channel.participantA === getSignerAddressFromPublicIdentifier(createEntity!.fromIdentifier);

  return {
    aliceSignature: aliceIsInitiator ? initialState.initiatorSignature : resolver.responderSignature,
    bobSignature: aliceIsInitiator ? resolver.responderSignature : initialState.initiatorSignature,
    channelAddress: channel.channelAddress,
    alice: channel.participantA,
    bob: channel.participantB,
    recipient: createEntity.transferToA!, // balance = [toA, toB]
    assetId: createEntity.assetId,
    amount: BigNumber.from(createEntity.transferAmountA)
      .sub(initialState.fee ?? 0)
      .toString(),
    nonce: initialState.nonce,
    callData: initialState.callData,
    callTo: initialState.callTo,
    transactionHash: transactionHash ?? resolveMeta.transactionHash ?? undefined,
  };
};

const convertEntityToChannelDispute = (dispute: ChannelDisputeEntity): ChannelDispute => {
  return {
    channelStateHash: dispute.channelStateHash,
    consensusExpiry: dispute.consensusExpiry,
    defundExpiry: dispute.defundExpiry,
    merkleRoot: dispute.merkleRoot,
    nonce: dispute.nonce,
  };
};

const convertEntityToTransferDispute = (entity: TransferDisputeEntity): TransferDispute => {
  return {
    isDefunded: entity.isDefunded,
    transferDisputeExpiry: entity.transferDisputeExpiry,
    transferId: entity.transferId,
    transferStateHash: entity.transferStateHash,
  };
};

@injectable()
export class PrismaStore implements IServerNodeStore {
  public prisma: PrismaClient;

  constructor(
    @inject("logger") logger: Logger,
    @inject("config") config: any,
    @inject("dbUrl") private readonly dbUrl?: string
    ) {
    const _dbUrl = this.dbUrl
      ? this.dbUrl
      : config.dbUrl?.startsWith("sqlite")
      ? `${config.dbUrl}?connection_limit=1&socket_timeout=10`
      : config.dbUrl;

    logger.info(`Creating PrismaClient with url: ${_dbUrl}`)

    const dbConfig = { 
      datasources: { 
        db: { url: _dbUrl } 
      },
      log: ['query', 'info', 'warn', 'error'],
      
    } 

    this.prisma = new PrismaClient(_dbUrl ? { 
                                              datasources: { db: { url: _dbUrl } },
                                              log: ['query', 'info', 'warn', 'error'],
                                              
                                            } 
                                            : undefined);

    // this.prisma = new PrismaClient(dbConfig)
    
  }

  /// Retrieve transaction by id.
  async getTransactionById(onchainTransactionId: string): Promise<StoredTransaction | undefined> {
    const entity = await this.prisma.onchainTransaction.findUnique({
      where: { id: onchainTransactionId },
      include: {
        channel: true,
        receipt: true,
        attempts: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });
    if (!entity) {
      return undefined;
    }
    return convertOnchainTransactionEntityToTransaction(entity);
  }

  /// Retrieve all tx's that have been submitted, but were not confirmed/mined
  /// (and did not fail).
  async getActiveTransactions(): Promise<StoredTransaction[]> {
    const activeTransactions = await this.prisma.onchainTransaction.findMany({
      where: {
        status: StoredTransactionStatus.submitted,
        receipt: undefined,
      },
      include: {
        receipt: true,
        channel: true,
        attempts: {
          orderBy: { createdAt: "asc" },
        },
      },
    });
    return activeTransactions.map(convertOnchainTransactionEntityToTransaction);
  }

  async saveTransactionAttempt(
    onchainTransactionId: string,
    channelAddress: string,
    reason: TransactionReason,
    response: TransactionResponse,
  ): Promise<void> {
    await this.prisma.onchainTransaction.upsert({
      where: { id: onchainTransactionId },
      create: {
        id: onchainTransactionId,
        status: StoredTransactionStatus.submitted,
        chainId: response.chainId.toString(),
        nonce: response.nonce,
        to: response.to ?? "",
        from: response.from,
        data: response.data,
        value: (response.value ?? BigNumber.from(0)).toString(),
        reason,
        receipt: undefined,
        attempts: {
          create: {
            gasLimit: (response.gasLimit ?? BigNumber.from(0)).toString(),
            gasPrice: (response.gasPrice ?? BigNumber.from(0)).toString(),
            transactionHash: response.hash,
          },
        },
        channel: {
          connect: {
            channelAddress,
          },
        },
      },
      update: {
        status: StoredTransactionStatus.submitted,
        reason,
        attempts: {
          create: {
            gasLimit: (response.gasLimit ?? BigNumber.from(0)).toString(),
            gasPrice: (response.gasPrice ?? BigNumber.from(0)).toString(),
            transactionHash: response.hash,
          },
        },
        channel: {
          connect: {
            channelAddress,
          },
        },
      },
      include: { channel: true },
    });
  }

  async saveTransactionReceipt(onchainTransactionId: string, receipt: TransactionReceipt): Promise<void> {
    await this.prisma.onchainTransaction.update({
      where: {
        id: onchainTransactionId,
      },
      data: {
        status: StoredTransactionStatus.mined,
        receipt: {
          create: {
            transactionHash: receipt.transactionHash,
            blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber,
            byzantium: receipt.byzantium,
            contractAddress: receipt.contractAddress,
            cumulativeGasUsed: (receipt.cumulativeGasUsed ?? BigNumber.from(0)).toString(),
            gasUsed: (receipt.gasUsed ?? BigNumber.from(0)).toString(),
            logs: receipt.logs.join(",").toString(),
            logsBloom: receipt.logsBloom,
            root: receipt.root,
            status: receipt.status,
            transactionIndex: receipt.transactionIndex,
          },
        },
      },
    });
  }

  async saveTransactionFailure(
    onchainTransactionId: string,
    error: string,
    receipt?: TransactionReceipt,
  ): Promise<void> {
    await this.prisma.onchainTransaction.update({
      where: {
        id: onchainTransactionId,
      },
      data: {
        error,
        status: StoredTransactionStatus.failed,
        receipt: receipt
          ? {
              create: {
                transactionHash: receipt.transactionHash,
                blockHash: receipt.blockHash,
                blockNumber: receipt.blockNumber,
                byzantium: receipt.byzantium,
                contractAddress: receipt.contractAddress,
                cumulativeGasUsed: (receipt.cumulativeGasUsed ?? BigNumber.from(0)).toString(),
                gasUsed: (receipt.gasUsed ?? BigNumber.from(0)).toString(),
                logs: receipt.logs.join(",").toString(),
                logsBloom: receipt.logsBloom,
                root: receipt.root,
                status: receipt.status,
                transactionIndex: receipt.transactionIndex,
              } as StoredTransactionReceipt,
            }
          : undefined,
      },
    });
  }

  async getWithdrawalCommitmentByTransactionHash(transactionHash: string): Promise<WithdrawCommitmentJson | undefined> {
    // use findFirst instead of findUnique. should be unique but
    // HashZero is used if the transaction was already submitted and we
    // have no record
    const entity = await this.prisma.transfer.findFirst({
      where: {
        onchainTransaction: {
          receipt: {
            transactionHash,
          },
        },
      },
      include: { channel: true, createUpdate: true, resolveUpdate: true, onchainTransaction: true },
    });
    if (!entity) {
      return undefined;
    }

    const channel =
      entity.channel ??
      (await this.prisma.channel.findUnique({
        where: { channelAddress: entity.channelAddressId },
      }));

    if (!channel) {
      throw new Error("Could not retrieve channel for withdraw commitment");
    }

    return convertEntitiesToWithdrawalCommitment(entity.resolveUpdate!, entity.createUpdate!, channel, transactionHash);
  }

  async getWithdrawalCommitment(transferId: string): Promise<WithdrawCommitmentJson | undefined> {
    const entity = await this.prisma.transfer.findUnique({
      where: { transferId },
      include: { channel: true, createUpdate: true, resolveUpdate: true, onchainTransaction: true },
    });
    if (!entity) {
      return undefined;
    }

    // if there is not an attached channel, the transfer has been resolved
    // so grab channel
    const channel =
      entity.channel ??
      (await this.prisma.channel.findUnique({
        where: { channelAddress: entity.channelAddressId },
      }));

    if (!channel) {
      throw new Error("Could not retrieve channel for withdraw commitment");
    }

    return convertEntitiesToWithdrawalCommitment(
      entity.resolveUpdate!,
      entity.createUpdate!,
      channel,
      // entity.onchainTransaction?.receipt?.transactionHash || undefined,
    );
  }

  async saveWithdrawalCommitment(transferId: string, withdrawCommitment: WithdrawCommitmentJson): Promise<void> {
    if (!withdrawCommitment.transactionHash) {
      return;
    }
    const record = await this.prisma.onchainTransaction.findFirst({
      where: {
        receipt: {
          transactionHash: withdrawCommitment.transactionHash,
        },
      },
    });
    if (!record) {
      // Did not submit transaction ourselves, no record to connect
      // This is the case for server-node bobs
      await this.prisma.transfer.update({
        where: { transferId },
        data: { transactionHash: withdrawCommitment.transactionHash },
      });
    } else {
      await this.prisma.transfer.update({
        where: { transferId },
        data: {
          onchainTransaction: { connect: { id: record.id } },
          transactionHash: withdrawCommitment.transactionHash,
        },
      });
    }
  }

  // NOTE: this does not exist on the browser node, only on the server node
  // This will pull *all* unsubmitted withdrawals that are not associated with
  // a transaction hash
  async getUnsubmittedWithdrawals(
    channelAddress: string,
    withdrawalDefinition: string,
  ): Promise<{ commitment: WithdrawCommitmentJson; transfer: FullTransferState }[]> {
    const entities = await this.prisma.transfer.findMany({
      where: {
        channelAddressId: channelAddress,
        transactionHash: null,
        resolveUpdateChannelAddressId: channelAddress,
        createUpdate: { transferDefinition: withdrawalDefinition },
      },
      include: { channel: true, createUpdate: true, resolveUpdate: true, dispute: true },
    });

    for (const transfer of entities) {
      if (!transfer.channel) {
        const channel = await this.prisma.channel.findUnique({ where: { channelAddress: transfer.channelAddressId } });
        transfer.channel = channel;
      }
    }

    return (
      entities
        .map((e) => {
          return {
            commitment: convertEntitiesToWithdrawalCommitment(e.resolveUpdate, e.createUpdate!, e.channel!),
            transfer: convertTransferEntityToFullTransferState(e),
          };
        })
        // filter canceled, need to do it here because it's a string in the db
        .filter((withdraw) => withdraw.transfer.transferResolver.responderSignature !== mkSig("0x0"))
    );
  }

  async registerSubscription<T extends EngineEvent>(publicIdentifier: string, event: T, url: string): Promise<void> {
    await this.prisma.eventSubscription.upsert({
      where: {
        publicIdentifier_event: {
          event,
          publicIdentifier,
        },
      },
      create: {
        publicIdentifier,
        event,
        url,
      },
      update: {
        url,
      },
    });
  }

  async getSubscription<T extends EngineEvent>(publicIdentifier: string, event: T): Promise<string | undefined> {
    const sub = await this.prisma.eventSubscription.findUnique({
      where: { publicIdentifier_event: { publicIdentifier, event: event as any } },
    });
    return sub ? sub.url : undefined;
  }

  async getSubscriptions(publicIdentifier: string): Promise<{ [event: string]: string }> {
    const subs = await this.prisma.eventSubscription.findMany({ where: { publicIdentifier } });
    return subs.reduce((s, sub) => {
      s[sub.event] = sub.url;
      return s;
    }, {} as { [event: string]: string });
  }

  getSchemaVersion(): Promise<number> {
    throw new Error("Method not implemented.");
  }

  updateSchemaVersion(version?: number): Promise<void> {
    throw new Error("Method not implemented.");
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async getUpdateById(id: string): Promise<ChannelUpdate | undefined> {
    const entity = await this.prisma.update.findUnique({ where: { id }, include: { channel: true } });
    if (!entity) {
      return undefined;
    }
    return convertUpdateEntityToChannelUpdate(entity);
  }

  async getChannelState(channelAddress: string): Promise<FullChannelState | undefined> {
    const channelEntity = await this.prisma.channel.findUnique({
      where: { channelAddress },
      include: { balances: true, latestUpdate: true, dispute: true },
    });
    if (!channelEntity) {
      return undefined;
    }

    return convertChannelEntityToFullChannelState(channelEntity);
  }

  async getChannelStateByParticipants(
    publicIdentifierA: string,
    publicIdentifierB: string,
    chainId: number,
  ): Promise<FullChannelState | undefined> {
    const [channelEntity] = await this.prisma.channel.findMany({
      where: {
        OR: [
          {
            publicIdentifierA,
            publicIdentifierB,
            chainId: chainId.toString(),
          },
          {
            publicIdentifierA: publicIdentifierB,
            publicIdentifierB: publicIdentifierA,
            chainId: chainId.toString(),
          },
        ],
      },
      include: { balances: true, latestUpdate: true, dispute: true },
    });
    if (!channelEntity) {
      return undefined;
    }

    return convertChannelEntityToFullChannelState(channelEntity);
  }

  async getChannelStates(): Promise<FullChannelState[]> {
    const channelEntities = await this.prisma.channel.findMany({
      include: { balances: true, latestUpdate: true, dispute: true },
    });
    return channelEntities.map(convertChannelEntityToFullChannelState);
  }

  async saveChannelState(channelState: FullChannelState, transfer?: FullTransferState): Promise<void> {
    // use the inputted assetIds to preserve order
    const assetIds = channelState.assetIds.join(",");

    // create the writes that must be executed
    // 1. channel
    const channelWrite = this.prisma.channel.upsert({
      where: { channelAddress: channelState.channelAddress },
      create: {
        channelAddress: channelState.channelAddress,
        publicIdentifierA: channelState.aliceIdentifier,
        publicIdentifierB: channelState.bobIdentifier,
        participantA: channelState.alice,
        participantB: channelState.bob,
        assetIds,
        timeout: channelState.timeout,
        nonce: channelState.nonce,
        merkleRoot: channelState.merkleRoot,
        channelFactoryAddress: channelState.networkContext.channelFactoryAddress,
        transferRegistryAddress: channelState.networkContext.transferRegistryAddress,
        chainId: channelState.networkContext.chainId.toString(),
      },
      update: {
        assetIds,
        nonce: channelState.nonce,
        merkleRoot: channelState.merkleRoot,
      },
    });

    // 2. balance
    let balanceWrites: PrismaPromise<any>[] = [];
    channelState.assetIds.forEach((assetId, index) => {
      const balanceToWrite = channelState.balances[index];
      const aliceWrite = this.prisma.balance.upsert({
        where: {
          participant_channelAddress_assetId: {
            assetId,
            channelAddress: channelState.channelAddress,
            participant: channelState.alice,
          },
        },
        create: {
          amount: balanceToWrite.amount[0],
          participant: channelState.alice,
          to: balanceToWrite.to[0],
          assetId,
          processedDeposit: channelState.processedDepositsA[index],
          defundNonce: channelState.defundNonces[index],
          channelAddress: channelState.channelAddress,
        },
        update: {
          amount: balanceToWrite.amount[0],
          processedDeposit: channelState.processedDepositsA[index],
          defundNonce: channelState.defundNonces[index],
          to: balanceToWrite.to[0],
        },
      });
      const bobWrite = this.prisma.balance.upsert({
        where: {
          participant_channelAddress_assetId: {
            assetId,
            channelAddress: channelState.channelAddress,
            participant: channelState.bob,
          },
        },
        create: {
          amount: balanceToWrite.amount[1],
          participant: channelState.bob,
          to: balanceToWrite.to[1],
          assetId,
          processedDeposit: channelState.processedDepositsB[index],
          defundNonce: channelState.defundNonces[index],
          channelAddress: channelState.channelAddress,
        },
        update: {
          amount: balanceToWrite.amount[1],
          processedDeposit: channelState.processedDepositsB[index],
          defundNonce: channelState.defundNonces[index],
          to: balanceToWrite.to[1],
        },
      });
      balanceWrites.push(aliceWrite);
      balanceWrites.push(bobWrite);
    });

    // 3. update
    const updateWrite = !channelState.latestUpdate
      ? undefined
      : this.prisma.update.upsert({
          where: {
            channelAddressId_nonce: {
              channelAddressId: channelState.channelAddress,
              nonce: channelState.latestUpdate.nonce,
            },
          },
          update: {
            channelAddressId: channelState.channelAddress,
            channel: { connect: { channelAddress: channelState.channelAddress } },
            fromIdentifier: channelState.latestUpdate.fromIdentifier,
            toIdentifier: channelState.latestUpdate.toIdentifier,
            nonce: channelState.latestUpdate!.nonce,
            signatureA: channelState.latestUpdate?.aliceSignature,
            signatureB: channelState.latestUpdate?.bobSignature,
            amountA: channelState.latestUpdate!.balance.amount[0],
            amountB: channelState.latestUpdate!.balance.amount[1],
            toA: channelState.latestUpdate!.balance.to[0],
            toB: channelState.latestUpdate!.balance.to[1],
            type: channelState.latestUpdate!.type,
            assetId: channelState.latestUpdate!.assetId,

            // details
            // deposit
            totalDepositsAlice: (channelState.latestUpdate!.details as DepositUpdateDetails).totalDepositsAlice,
            totalDepositsBob: (channelState.latestUpdate!.details as DepositUpdateDetails).totalDepositsBob,

            // create
            transferInitialState: (channelState.latestUpdate!.details as CreateUpdateDetails).transferInitialState
              ? JSON.stringify((channelState.latestUpdate!.details as CreateUpdateDetails).transferInitialState)
              : undefined,
            transferAmountA:
              (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.amount[0] ?? undefined,
            transferToA: (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.to[0] ?? undefined,
            transferAmountB:
              (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.amount[1] ?? undefined,
            transferToB: (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.to[1] ?? undefined,
            merkleRoot: (channelState.latestUpdate!.details as CreateUpdateDetails).merkleRoot,
            transferDefinition: (channelState.latestUpdate!.details as CreateUpdateDetails).transferDefinition,
            transferEncodings: (channelState.latestUpdate!.details as CreateUpdateDetails).transferEncodings
              ? (channelState.latestUpdate!.details as CreateUpdateDetails).transferEncodings.join("$") // comma separation doesnt work
              : undefined,
            transferId: (channelState.latestUpdate!.details as CreateUpdateDetails).transferId,
            transferTimeout: (channelState.latestUpdate!.details as CreateUpdateDetails).transferTimeout,
            meta: (channelState.latestUpdate!.details as CreateUpdateDetails).meta
              ? JSON.stringify((channelState.latestUpdate!.details as CreateUpdateDetails).meta)
              : undefined,

            // resolve
            transferResolver: (channelState.latestUpdate!.details as ResolveUpdateDetails).transferResolver
              ? JSON.stringify((channelState.latestUpdate!.details as ResolveUpdateDetails).transferResolver)
              : undefined,
          },
          create: {
            id: channelState.latestUpdate.id.id,
            idSignature: channelState.latestUpdate.id.signature,
            channelAddressId: channelState.channelAddress,
            channel: { connect: { channelAddress: channelState.channelAddress } },
            fromIdentifier: channelState.latestUpdate.fromIdentifier,
            toIdentifier: channelState.latestUpdate.toIdentifier,
            nonce: channelState.latestUpdate!.nonce,
            signatureA: channelState.latestUpdate?.aliceSignature,
            signatureB: channelState.latestUpdate?.bobSignature,
            amountA: channelState.latestUpdate!.balance.amount[0],
            amountB: channelState.latestUpdate!.balance.amount[1],
            toA: channelState.latestUpdate!.balance.to[0],
            toB: channelState.latestUpdate!.balance.to[1],
            type: channelState.latestUpdate!.type,
            assetId: channelState.latestUpdate!.assetId,

            // details
            // deposit
            totalDepositsAlice: (channelState.latestUpdate!.details as DepositUpdateDetails).totalDepositsAlice,
            totalDepositsBob: (channelState.latestUpdate!.details as DepositUpdateDetails).totalDepositsBob,

            // create
            transferInitialState: (channelState.latestUpdate!.details as CreateUpdateDetails).transferInitialState
              ? JSON.stringify((channelState.latestUpdate!.details as CreateUpdateDetails).transferInitialState)
              : undefined,

            transferAmountA:
              (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.amount[0] ?? undefined,
            transferToA: (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.to[0] ?? undefined,
            transferAmountB:
              (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.amount[1] ?? undefined,
            transferToB: (channelState.latestUpdate!.details as CreateUpdateDetails).balance?.to[1] ?? undefined,
            merkleRoot: (channelState.latestUpdate!.details as CreateUpdateDetails).merkleRoot,
            transferDefinition: (channelState.latestUpdate!.details as CreateUpdateDetails).transferDefinition,
            transferEncodings: (channelState.latestUpdate!.details as CreateUpdateDetails).transferEncodings
              ? (channelState.latestUpdate!.details as CreateUpdateDetails).transferEncodings.join("$") // comma separation doesnt work
              : undefined,
            transferId: (channelState.latestUpdate!.details as CreateUpdateDetails).transferId,
            transferTimeout: (channelState.latestUpdate!.details as CreateUpdateDetails).transferTimeout,
            meta: (channelState.latestUpdate!.details as CreateUpdateDetails).meta
              ? JSON.stringify((channelState.latestUpdate!.details as CreateUpdateDetails).meta)
              : undefined,

            // resolve
            transferResolver: (channelState.latestUpdate!.details as ResolveUpdateDetails).transferResolver
              ? JSON.stringify((channelState.latestUpdate!.details as ResolveUpdateDetails).transferResolver)
              : undefined,
          },
        });

    // 4. transfer
    let transferWrite = undefined;
    if (channelState.latestUpdate?.type === UpdateType.create) {
      transferWrite = this.prisma.transfer.create({
        data: {
          channelAddressId: channelState.channelAddress,
          transferId: transfer!.transferId,
          routingId: transfer!.meta?.routingId ?? getRandomBytes32(),
          amountA: transfer!.balance.amount[0],
          toA: transfer!.balance.to[0],
          amountB: transfer!.balance.amount[1],
          toB: transfer!.balance.to[1],
          initialStateHash: transfer!.initialStateHash,
          channelNonce: transfer!.channelNonce,
          channel: { connect: { channelAddress: channelState.channelAddress } },
          createUpdate: {
            connect: {
              channelAddressId_nonce: { channelAddressId: transfer!.channelAddress, nonce: channelState.nonce },
            },
          },
        },
      });
    } else if (channelState.latestUpdate?.type === UpdateType.resolve) {
      transferWrite = this.prisma.transfer.update({
        where: { transferId: transfer!.transferId },
        data: {
          amountA: transfer!.balance.amount[0],
          toA: transfer!.balance.to[0],
          amountB: transfer!.balance.amount[1],
          toB: transfer!.balance.to[1],
          channel: { disconnect: true },
          resolveUpdate: {
            connect: {
              channelAddressId_nonce: { channelAddressId: transfer!.channelAddress, nonce: channelState.nonce },
            },
          },
        },
      });
    }

    await this.prisma.$transaction(
      [channelWrite, ...balanceWrites, updateWrite, transferWrite].filter((x) => !!x) as PrismaPromise<any>[],
    );
  }

  async saveChannelStateAndTransfers(
    channel: FullChannelState<any>,
    activeTransfers: FullTransferState[],
  ): Promise<void> {
    // make sure any old records are removed
    const balanceDelete = this.prisma.balance.deleteMany({ where: { channelAddress: channel.channelAddress } });
    const updateDelete = this.prisma.update.deleteMany({ where: { channelAddress: channel.channelAddress } });
    const transferDelete = this.prisma.transfer.deleteMany({ where: { channelAddress: channel.channelAddress } });
    const channelDelete = this.prisma.channel.deleteMany({ where: { channelAddress: channel.channelAddress } });
    // add these calls to the transaction at the end

    // create the latest update db structure from the input data
    let latestUpdateModel: Prisma.UpdateCreateInput | undefined;
    if (channel.latestUpdate) {
      latestUpdateModel = {
        id: channel.latestUpdate.id.id,
        idSignature: channel.latestUpdate.id.signature,
        channelAddressId: channel.channelAddress,
        fromIdentifier: channel.latestUpdate!.fromIdentifier,
        toIdentifier: channel.latestUpdate!.toIdentifier,
        nonce: channel.latestUpdate!.nonce,
        signatureA: channel.latestUpdate?.aliceSignature,
        signatureB: channel.latestUpdate?.bobSignature,
        amountA: channel.latestUpdate!.balance.amount[0],
        amountB: channel.latestUpdate!.balance.amount[1],
        toA: channel.latestUpdate!.balance.to[0],
        toB: channel.latestUpdate!.balance.to[1],
        type: channel.latestUpdate!.type,
        assetId: channel.latestUpdate!.assetId,

        // details
        // deposit
        totalDepositsAlice: (channel.latestUpdate!.details as DepositUpdateDetails).totalDepositsAlice,
        totalDepositsBob: (channel.latestUpdate!.details as DepositUpdateDetails).totalDepositsBob,

        // create transfer
        transferInitialState: (channel.latestUpdate!.details as CreateUpdateDetails).transferInitialState
          ? JSON.stringify((channel.latestUpdate!.details as CreateUpdateDetails).transferInitialState)
          : undefined,

        transferAmountA: (channel.latestUpdate!.details as CreateUpdateDetails).balance?.amount[0] ?? undefined,
        transferToA: (channel.latestUpdate!.details as CreateUpdateDetails).balance?.to[0] ?? undefined,
        transferAmountB: (channel.latestUpdate!.details as CreateUpdateDetails).balance?.amount[1] ?? undefined,
        transferToB: (channel.latestUpdate!.details as CreateUpdateDetails).balance?.to[1] ?? undefined,
        merkleRoot: (channel.latestUpdate!.details as CreateUpdateDetails).merkleRoot,
        transferDefinition: (channel.latestUpdate!.details as CreateUpdateDetails).transferDefinition,
        transferEncodings: (channel.latestUpdate!.details as CreateUpdateDetails).transferEncodings
          ? (channel.latestUpdate!.details as CreateUpdateDetails).transferEncodings.join("$") // comma separation doesnt work
          : undefined,
        transferId: (channel.latestUpdate!.details as CreateUpdateDetails).transferId,
        transferTimeout: (channel.latestUpdate!.details as CreateUpdateDetails).transferTimeout,
        meta: (channel.latestUpdate!.details as CreateUpdateDetails).meta
          ? JSON.stringify((channel.latestUpdate!.details as CreateUpdateDetails).meta)
          : undefined,

        // resolve transfer
        transferResolver: (channel.latestUpdate!.details as ResolveUpdateDetails).transferResolver
          ? JSON.stringify((channel.latestUpdate!.details as ResolveUpdateDetails).transferResolver)
          : undefined,

        // create update will be generated by activeTransfers

        // if resolve, add resolvedTransfer by transferId
        // NOTE: no guarantee that this transfer exists, will not save
      };
    }

    // use the inputted assetIds to preserve order
    const assetIds = channel.assetIds.join(",");

    // create entities for each active transfer + associated create update
    const transferEntityDetails: Prisma.TransferCreateInput[] = activeTransfers.map((transfer) => {
      return {
        createUpdate: {
          create: {
            // common fields
            channelAddressId: transfer.channelAddress,
            fromIdentifier: transfer.initiatorIdentifier,
            toIdentifier: transfer.responderIdentifier,
            type: UpdateType.create,
            nonce: transfer.channelNonce + 1, // transfer created, then update proposed
            amountA: "", // channel balance unkown
            amountB: "", // channel balance unkown
            toA: channel.alice,
            toB: channel.bob,
            assetId: transfer.assetId,
            signatureA: "", // commitment sigs unknown
            signatureB: "", // commitment sigs unknown
            // detail fields
            transferAmountA: transfer.balance.amount[0],
            transferAmountB: transfer.balance.amount[1],
            transferToA: transfer.balance.to[0],
            transferToB: transfer.balance.to[1],
            transferId: transfer.transferId,
            transferDefinition: transfer.transferDefinition,
            transferTimeout: transfer.transferTimeout,
            transferInitialState: JSON.stringify(transfer.transferState),
            transferEncodings: transfer.transferEncodings.join("$"),
            meta: transfer.meta ? JSON.stringify(transfer.meta) : undefined,
            responder: transfer.responder,
          },
        },
        channelAddressId: transfer.channelAddress,
        transferId: transfer.transferId,
        routingId: transfer.meta?.routingId ?? getRandomBytes32(),
        amountA: transfer.balance.amount[0],
        toA: transfer.balance.to[0],
        amountB: transfer.balance.amount[1],
        toB: transfer.balance.to[1],
        initialStateHash: transfer!.initialStateHash,
        channelNonce: transfer.channelNonce,
      };
    });

    const channelModelDetails: Prisma.ChannelCreateInput = {
      assetIds,
      chainId: channel.networkContext.chainId.toString(),
      channelAddress: channel.channelAddress,
      channelFactoryAddress: channel.networkContext.channelFactoryAddress,
      transferRegistryAddress: channel.networkContext.transferRegistryAddress,
      merkleRoot: channel.merkleRoot,
      nonce: channel.nonce,
      participantA: channel.alice,
      participantB: channel.bob,
      publicIdentifierA: channel.aliceIdentifier,
      publicIdentifierB: channel.bobIdentifier,
      timeout: channel.timeout,
      balances: {
        create: channel.assetIds.flatMap((assetId: string, index: number) => {
          return [
            {
              amount: channel.balances[index].amount[0],
              participant: channel.alice,
              to: channel.balances[index].to[0],
              assetId,
              processedDeposit: channel.processedDepositsA[index],
              defundNonce: channel.defundNonces[index],
            },
            {
              amount: channel.balances[index].amount[1],
              participant: channel.bob,
              to: channel.balances[index].to[1],
              assetId,
              processedDeposit: channel.processedDepositsB[index],
              defundNonce: channel.defundNonces[index],
            },
          ];
        }),
      },
      latestUpdate: {
        connectOrCreate: {
          where: {
            channelAddressId_nonce: {
              channelAddressId: channel.channelAddress,
              nonce: channel.latestUpdate!.nonce,
            },
          },
          create: latestUpdateModel!,
        },
      },
      activeTransfers: { create: transferEntityDetails },
    };

    const channelCreate = this.prisma.channel.create({
      data: channelModelDetails,
    });

    await this.prisma.$transaction([balanceDelete, updateDelete, transferDelete, channelDelete, channelCreate]);
  }

  async getActiveTransfers(channelAddress: string): Promise<FullTransferState[]> {
    const transferEntities = await this.prisma.transfer.findMany({
      where: { channelAddress },
      include: { channel: true, createUpdate: true, resolveUpdate: true, dispute: true },
    });
    const transfers = transferEntities.map(convertTransferEntityToFullTransferState);
    return transfers;
  }

  async getTransferState(transferId: string): Promise<FullTransferState | undefined> {
    // should be only 1, verify this is always true
    const transfer = await this.prisma.transfer.findUnique({
      where: { transferId },
      include: { channel: true, createUpdate: true, resolveUpdate: true, dispute: true },
    });

    if (!transfer) {
      return undefined;
    }

    // not ideal, but if the channel has been detatched we need to re-attach it separatedly... todo: use join queries #430
    if (!transfer.channel) {
      const channel = await this.prisma.channel.findUnique({ where: { channelAddress: transfer.channelAddressId } });
      transfer.channel = channel;
    }

    return convertTransferEntityToFullTransferState(transfer);
  }

  async getTransferByRoutingId(channelAddress: string, routingId: string): Promise<FullTransferState | undefined> {
    const transfer = await this.prisma.transfer.findUnique({
      where: { routingId_channelAddressId: { routingId, channelAddressId: channelAddress } },
      include: { channel: true, createUpdate: true, resolveUpdate: true, dispute: true },
    });

    if (!transfer) {
      return undefined;
    }

    // not ideal, but if the channel has been detatched we need to re-attach it separatedly... todo: use join queries #430
    if (!transfer.channel) {
      const channel = await this.prisma.channel.findUnique({ where: { channelAddress: transfer.channelAddressId } });
      transfer.channel = channel;
    }

    return convertTransferEntityToFullTransferState(transfer);
  }

  async getTransfers(filterOpts?: GetTransfersFilterOpts): Promise<FullTransferState[]> {
    const filterQuery: Prisma.TransferWhereInput[] = [];
    if (filterOpts?.channelAddress) {
      filterQuery.push({ channelAddressId: filterOpts.channelAddress });
    }

    // start and end
    if (filterOpts?.startDate && filterOpts.endDate) {
      filterQuery.push({ createdAt: { gte: filterOpts.startDate, lte: filterOpts.endDate } });
    } else if (filterOpts?.startDate) {
      filterQuery.push({ createdAt: { gte: filterOpts.startDate } });
    } else if (filterOpts?.endDate) {
      filterQuery.push({ createdAt: { lte: filterOpts.endDate } });
    }

    if (filterOpts?.active) {
      filterQuery.push({ channelAddress: filterOpts.channelAddress });
    }

    if (filterOpts?.routingId) {
      filterQuery.push({ routingId: filterOpts.routingId });
    }

    if (filterOpts?.transferDefinition) {
      filterQuery.push({ createUpdate: { transferDefinition: filterOpts.transferDefinition } });
    }

    const transfers = await this.prisma.transfer.findMany({
      where: filterOpts ? { AND: filterQuery } : undefined,
      include: {
        channel: true,
        createUpdate: true,
        resolveUpdate: true,
        dispute: true,
      },
    });

    for (const transfer of transfers) {
      if (!transfer.channel) {
        const channel = await this.prisma.channel.findUnique({ where: { channelAddress: transfer.channelAddressId } });
        transfer.channel = channel;
      }
    }

    return transfers.map(convertTransferEntityToFullTransferState);
  }

  async getTransfersByRoutingId(routingId: string): Promise<FullTransferState[]> {
    const transfers = await this.prisma.transfer.findMany({
      where: { routingId },
      include: {
        channel: true,
        createUpdate: true,
        resolveUpdate: true,
        dispute: true,
      },
    });

    for (const transfer of transfers) {
      if (!transfer.channel) {
        const channel = await this.prisma.channel.findUnique({ where: { channelAddress: transfer.channelAddressId } });
        transfer.channel = channel;
      }
    }

    return transfers.map(convertTransferEntityToFullTransferState);
  }

  //////////////////////////////////
  ///// DISPUTE METHODS
  //////////////////////////////////
  async saveChannelDispute(channelAddress: string, channelDispute: ChannelDispute): Promise<void> {
    await this.prisma.channelDispute.upsert({
      where: { channelAddress },
      create: {
        channelStateHash: channelDispute.channelStateHash,
        consensusExpiry: channelDispute.consensusExpiry,
        defundExpiry: channelDispute.defundExpiry,
        merkleRoot: channelDispute.merkleRoot,
        nonce: channelDispute.nonce,
        channel: { connect: { channelAddress } },
      },
      update: {
        channelStateHash: channelDispute.channelStateHash,
        consensusExpiry: channelDispute.consensusExpiry,
        defundExpiry: channelDispute.defundExpiry,
        merkleRoot: channelDispute.merkleRoot,
        nonce: channelDispute.nonce,
        channel: { connect: { channelAddress } },
      },
    });
  }

  async getChannelDispute(channelAddress: string): Promise<ChannelDispute | undefined> {
    const entity = await this.prisma.channelDispute.findUnique({
      where: {
        channelAddress,
      },
    });
    if (!entity) {
      return undefined;
    }
    return convertEntityToChannelDispute(entity);
  }

  async saveTransferDispute(transferId: string, transferDispute: TransferDispute): Promise<void> {
    // TODO: fix the storage of the onchain transfer reference
    const offchain = await this.prisma.transfer.findUnique({ where: { transferId } });
    await this.prisma.transferDispute.upsert({
      where: { transferId },
      create: {
        isDefunded: transferDispute.isDefunded,
        transferStateHash: transferDispute.transferStateHash,
        transferDisputeExpiry: transferDispute.transferDisputeExpiry,
        transfer: { connect: { transferId } },
      },
      update: {
        isDefunded: transferDispute.isDefunded,
        transferStateHash: transferDispute.transferStateHash,
        transferDisputeExpiry: transferDispute.transferDisputeExpiry,
        transfer: { connect: { transferId } },
      },
    });
  }

  async getTransferDispute(transferId: string): Promise<TransferDispute | undefined> {
    const entity = await this.prisma.transferDispute.findUnique({
      where: {
        transferId,
      },
    });
    if (!entity) {
      return undefined;
    }
    return convertEntityToTransferDispute(entity);
  }

  async setNodeIndex(index: number, publicIdentifier: string): Promise<void> {
    await this.prisma.nodeIndex.upsert({
      where: {
        index,
      },
      create: {
        index,
        publicIdentifier,
      },
      update: {
        publicIdentifier,
      },
    });
  }

  async getNodeIndexes(): Promise<{ index: number; publicIdentifier: string }[]> {
    const entries = await this.prisma.nodeIndex.findMany();
    return entries;
  }

  async removeNodeIndexes(): Promise<void> {
    await this.prisma.nodeIndex.deleteMany({});
  }

  async clear(): Promise<void> {
    await this.prisma.balance.deleteMany({});
    // NOTE: onchainTransactionAttempt and onchainTransactionReceipt MUST be deleted before onchainTransaction
    // This essentially is an application-side implementation of a CASCADE delete, since Prisma 2 does not support
    // CASCADE delete.
    await this.prisma.onchainTransactionAttempt.deleteMany({});
    await this.prisma.onchainTransactionReceipt.deleteMany({});
    await this.prisma.onchainTransaction.deleteMany({});
    await this.prisma.transfer.deleteMany({});
    await this.prisma.channelDispute.deleteMany({});
    await this.prisma.channel.deleteMany({});
    await this.prisma.update.deleteMany({});
    await this.prisma.configuration.deleteMany({});
    await this.prisma.nodeIndex.deleteMany({});
  }
}
