import * as merkle from "@connext/vector-merkle-tree";
import { createCoreTransferState, expect } from "./test";
import { getRandomBytes32, isValidBytes32 } from "./hexStrings";
import { generateMerkleRoot } from "./merkle";
import { hashCoreTransferState, encodeCoreTransferState } from "./transfers";

import { MerkleTree } from "merkletreejs";
import { keccak256 } from "ethereumjs-util";
import { keccak256 as solidityKeccak256 } from "@ethersproject/solidity";
import { bufferify } from "./crypto";
import { CoreTransferState } from "@connext/vector-types";

const generateMerkleTreeJs = (transfers: CoreTransferState[]) => {
  const sorted = transfers.sort((a, b) => a.transferId.localeCompare(b.transferId));

  const leaves = sorted.map((transfer) => hashCoreTransferState(transfer));
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  return tree;
};

describe("generateMerkleRoot", () => {
  const generateTransfers = (noTransfers = 1): CoreTransferState[] => {
    return Array(noTransfers)
      .fill(0)
      .map((_, i) => {
        return createCoreTransferState({ transferId: getRandomBytes32() });
      });
  };

  const getMerkleTreeRoot = (transfers: CoreTransferState[]): string => {
    const data = generateMerkleRoot(transfers);
    return data;
  };

  it.skip("Is not very slow", () => {
    let count = 2000;

    let start = Date.now();

    let tree = new merkle.Tree();
    let each = Date.now();
    try {
      for (let i = 0; i < count; i++) {
        tree.insertHex(encodeCoreTransferState(generateTransfers(1)[0]));
        let _calculated = tree.root();

        if (i % 50 === 0) {
          let now = Date.now();
          console.log("Count:", i, " ", (now - each) / 50, "ms ", (now - start) / 1000, "s");
          each = now;
        }
      }
    } finally {
      tree.free();
    }

    console.log("Time Good:", Date.now() - start);

    console.log("-------");

    start = Date.now();

    each = Date.now();
    const encodedTransfers = [];
    for (let i = 0; i < count; i++) {
      encodedTransfers.push(encodeCoreTransferState(generateTransfers(1)[0]));

      tree = new merkle.Tree();
      try {
        for (let encoded of encodedTransfers) {
          tree.insertHex(encoded);
        }
        let _calculated = tree.root();

        if (i % 50 === 0) {
          let now = Date.now();
          console.log("Count:", i, " ", (now - each) / 50, "ms ", (now - start) / 1000, "s");
          each = now;
        }
      } finally {
        tree.free();
      }
    }

    console.log("Time Some:", Date.now() - start);

    console.log("-------");

    start = Date.now();

    let transfers = [];
    each = Date.now();
    for (let i = 0; i < count; i++) {
      transfers.push(generateTransfers(1)[0]);
      generateMerkleRoot(transfers);
      if (i % 50 === 0) {
        let now = Date.now();
        console.log("Count:", i, " ", (now - each) / 50, "ms ", (now - start) / 1000, "s");
        each = now;
      }
    }
    console.log("Time Bad:", Date.now() - start);
  });

  it("should work for a single transfer", () => {
    const [transfer] = generateTransfers();
    const root = getMerkleTreeRoot([transfer]);
    const tree = generateMerkleTreeJs([transfer]);
    expect(root).to.be.eq(tree.getHexRoot());
    expect(isValidBytes32(root)).to.be.true;

    const leaf = hashCoreTransferState(transfer);
    expect(tree.verify(tree.getHexProof(leaf), leaf, root)).to.be.true;
  });

  it("should generate the same root for both libs", () => {
    const transfers = generateTransfers(15);
    const root = getMerkleTreeRoot(transfers);

    const sorted = transfers.sort((a, b) => a.transferId.localeCompare(b.transferId));

    const leaves = sorted.map((transfer) => hashCoreTransferState(transfer));
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    expect(root).to.be.eq(tree.getHexRoot());
  });

  it("should work for multiple transfers", () => {
    const transfers = generateTransfers(15);

    const randomIdx = Math.floor(Math.random() * 1);
    const toProve = transfers[randomIdx];

    const root = getMerkleTreeRoot(transfers);
    const tree = generateMerkleTreeJs(transfers);
    expect(root).to.be.eq(tree.getHexRoot());
    expect(isValidBytes32(root)).to.be.true;

    const leaf = hashCoreTransferState(toProve);
    expect(tree.verify(tree.getHexProof(leaf), leaf, root)).to.be.true;
  });

  it("library should work in general", () => {
    const numLeaves = 2;
    const leaves = Array(numLeaves)
      .fill(0)
      .map(() => getRandomBytes32());

    const randomIdx = Math.floor(Math.random() * numLeaves);

    // test with ethereumjs
    const hashedKeccak = leaves.map((l) => keccak256(bufferify(l)));

    // test with solidity
    const hashedSolidity = leaves.map((l) => solidityKeccak256(["bytes32"], [l]));

    expect(hashedKeccak.map((l) => "0x" + l.toString("hex"))).to.be.deep.eq(hashedSolidity);
    const treeKeccak = new MerkleTree(hashedKeccak, keccak256, { sortPairs: true });

    // Generate tree with ethereumjs
    const pHexProof = treeKeccak.getPositionalHexProof(hashedKeccak[randomIdx], randomIdx);
    const verifyEthJsPositional = treeKeccak.verify(pHexProof, hashedKeccak[randomIdx], treeKeccak.getHexRoot());
    expect(verifyEthJsPositional).to.be.true;

    const proof = treeKeccak.getProof(hashedKeccak[randomIdx], randomIdx);
    const verifyEthJsReg = treeKeccak.verify(proof, hashedKeccak[randomIdx], treeKeccak.getHexRoot());
    expect(verifyEthJsReg).to.be.true;

    const foo = proof.map((p) => "0x" + p.data.toString("hex"));
    const verifyEthJsRegMapped = treeKeccak.verify(foo, hashedKeccak[randomIdx], treeKeccak.getHexRoot());
    expect(verifyEthJsRegMapped).to.be.true;

    const hexProof = treeKeccak.getHexProof(hashedKeccak[randomIdx], randomIdx);
    const verifyEthJsHex = treeKeccak.verify(hexProof, hashedKeccak[randomIdx], treeKeccak.getHexRoot());
    expect(verifyEthJsHex).to.be.true;
  });
});
