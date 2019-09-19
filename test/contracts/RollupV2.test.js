/* eslint-disable no-underscore-dangle */
/* global artifacts */
/* global contract */
/* global web3 */
/* global BigInt */

const chai = require("chai");
const RollupTree = require("../../rollup-utils/rollup-tree");
const rollupUtils = require("../../rollup-utils/rollup-utils.js");
const { BabyJubWallet } = require("../../rollup-utils/babyjub-wallet");

const { expect } = chai;
const poseidonUnit = require("../../node_modules/circomlib/src/poseidon_gencontract.js");

const TokenRollup = artifacts.require("../contracts/test/TokenRollup");
const Verifier = artifacts.require("../contracts/test/VerifierHelper");
const StakerManager = artifacts.require("../contracts/RollupPoS");
const RollupTest = artifacts.require("../contracts/test/RollupTestV2");

contract("Rollup", (accounts) => { 
    const maxTx = 10;
    const maxOnChainTx = 3;
    let balanceTree;
    let exitTree;
    let fillingOnChainTest;
    let minningOnChainTest;

    let insPoseidonUnit;
    let insTokenRollup;
    let insStakerManager;
    let insRollupTest;
    let insVerifier;

    // BabyJubjub public key
    const mnemonic = "urban add pulse prefer exist recycle verb angle sell year more mosquito";
    const wallet = BabyJubWallet.fromMnemonic(mnemonic);
    const Ax = wallet.publicKey[0].toString();
    const Ay = wallet.publicKey[1].toString();

    // tokenRollup initial amount
    const tokenInitialAmount = 100;

    const {
        0: owner,
        1: id1,
        2: ethAddress,
        3: tokenList,
        4: beneficiary,
        5: onAddress,
    } = accounts;

    before(async () => {
        // Deploy poseidon
        const C = new web3.eth.Contract(poseidonUnit.abi);
        insPoseidonUnit = await C.deploy({ data: poseidonUnit.createCode() })
            .send({ gas: 2500000, from: owner });

        // Deploy TokenRollup
        insTokenRollup = await TokenRollup.new(id1, tokenInitialAmount);

        // Deploy Verifier
        insVerifier = await Verifier.new();

        // Deploy Rollup test
        insRollupTest = await RollupTest.new(insVerifier.address, insPoseidonUnit._address,
            maxTx, maxOnChainTx);

        // Deploy Staker manager
        insStakerManager = await StakerManager.new(insRollupTest.address);

        // Init balance and exit tree
        balanceTree = await RollupTree.newMemRollupTree();
        exitTree = await RollupTree.newMemRollupTree();
    });

    it("Check ganache provider", async () => {
        if (accounts.length < 12) {
            throw new Error("launch ganache with more than 12 accounts:\n\n `ganache-cli -a 20`");
        }
    });

    it("Load forge batch mechanism", async () => {
        await insRollupTest.loadForgeBatchMechanism(insStakerManager.address);
        try {
            await insRollupTest.loadForgeBatchMechanism(insStakerManager.address, { from: id1 });
        } catch (error) {
            expect((error.message).includes("caller is not the owner")).to.be.equal(true);
        }
    });

    it("Distribute token rollup", async () => {
        await insTokenRollup.transfer(onAddress, 50, { from: id1 });
    });

    it("Rollup token listing", async () => {
    // Check balances token
        const resOwner = await insTokenRollup.balanceOf(owner);
        const resId1 = await insTokenRollup.balanceOf(id1);
        expect(resOwner.toString()).to.be.equal("0");
        expect(resId1.toString()).to.be.equal("50");

        // Add token to rollup token list
        const resAddToken = await insRollupTest.addToken(insTokenRollup.address,
            { from: tokenList, value: web3.utils.toWei("1", "ether") });

        expect(resAddToken.logs[0].event).to.be.equal("AddToken");
        expect(resAddToken.logs[0].args.tokenAddress).to.be.equal(insTokenRollup.address);
        expect(resAddToken.logs[0].args.tokenId.toString()).to.be.equal("0");
    });

    it("Check token address", async () => {
    // Check token address
        const resTokenAddress = await insRollupTest.getTokenAddress(0);
        expect(resTokenAddress).to.be.equal(insTokenRollup.address);
    });

    it("Deposit", async () => {
    // Steps:
    // - Transaction to deposit 'TokenRollup' from 'id1' to 'rollup smart contract'(owner)
    // - Check 'tokenRollup' balances
    // - Get event data
    // - Add leaf to balance tree
    // - Check 'filling on-chain' hash

        const depositAmount = 10;
        const tokenId = 0;

        const resApprove = await insTokenRollup.approve(insRollupTest.address, depositAmount, { from: id1 });
        expect(resApprove.logs[0].event).to.be.equal("Approval");

        let fillingOnChainTxsHash = await insRollupTest.getFillingOnChainTxsHash();

        const resDeposit = await insRollupTest.deposit(depositAmount, tokenId, ethAddress,
            [Ax, Ay], { from: id1, value: web3.utils.toWei("1", "ether") });
        expect(resDeposit.logs[0].event).to.be.equal("Deposit");

        // Check token balances for id1 and rollup smart contract
        const resRollup = await insTokenRollup.balanceOf(insRollupTest.address);
        const resId1 = await insTokenRollup.balanceOf(id1);
        expect(resRollup.toString()).to.be.equal("10");
        expect(resId1.toString()).to.be.equal("40");

        // Get event 'Deposit' data
        const resBatchNumber = BigInt(resDeposit.logs[0].args.batchNumber);
        const resTxData = resDeposit.logs[0].args.txData;
        const resLoadAmount = BigInt(resDeposit.logs[0].args.loadAmount);
        const resEthAddress = BigInt(resDeposit.logs[0].args.ethAddress);
        const resAx = BigInt(resDeposit.logs[0].args.Ax);
        const resAy = BigInt(resDeposit.logs[0].args.Ay);

        const txDataDecoded = rollupUtils.decodeTxData(resTxData);
        // add leaf to balance tree
        await balanceTree.addId(txDataDecoded.fromId, resLoadAmount, txDataDecoded.tokenId,
            resAx, resAy, resEthAddress, BigInt(0));

        // Calculate Deposit hash given the events triggered
        fillingOnChainTxsHash = rollupUtils.hashOnChain(BigInt(fillingOnChainTxsHash), BigInt(resTxData),
            resLoadAmount, resEthAddress, resAx, resAy).hash;

        const resFillingTest = await insRollupTest.getFillingOnChainTxsHash();
        
        expect(fillingOnChainTxsHash.toString()).to.be.equal(BigInt(resFillingTest).toString());
        expect(resBatchNumber.toString()).to.be.equal("0");

        // Update on-chain hashes
        fillingOnChainTest = BigInt(resFillingTest).toString();
        minningOnChainTest = 0;
    });
});