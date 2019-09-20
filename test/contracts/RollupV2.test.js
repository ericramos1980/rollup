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

const RollupDB = require("../../js/rollupdb");
const SMTMemDB = require("circomlib/src/smt_memdb");

function buildInputSm(bb, beneficiary) {
    return {
        oldStateRoot: bb.getInput().oldStRoot.toString(),
        newStateRoot: bb.getNewStateRoot().toString(),
        newExitRoot: bb.getNewExitRoot().toString(),
        onChainHash: bb.getOnChainHash().toString(),
        feePlan: bb.feePlan.length ? bb.feePlan : [0, 0],
        compressedTx: `0x${bb.getDataAvailable().toString("hex")}`,
        offChainHash: bb.getOffChainHash().toString(),
        nTxPerToken: bb.getCountersOut().toString(),
        beneficiary: beneficiary
    };
}

contract("Rollup", (accounts) => { 
    const maxTx = 10;
    const maxOnChainTx = 3;
    const nLevels = 24;
    let db;
    let rollupDB;

    // Init balance and exit tree
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
        
        // init rollup databse
        db = new SMTMemDB();
        rollupDB = await RollupDB(db);
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

    it("Deposit, forge genesis and forge deposit transaction", async () => {
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

        const resDeposit = await insRollupTest.deposit(depositAmount, tokenId, ethAddress,
            [Ax, Ay], { from: id1, value: web3.utils.toWei("1", "ether") });
        expect(resDeposit.logs[0].event).to.be.equal("OnChainTx");

        // Check token balances for id1 and rollup smart contract
        const resRollup = await insTokenRollup.balanceOf(insRollupTest.address);
        const resId1 = await insTokenRollup.balanceOf(id1);
        expect(resRollup.toString()).to.be.equal("10");
        expect(resId1.toString()).to.be.equal("40");

        // Get event 'OnChainTx' data
        const resBatchNumber = BigInt(resDeposit.logs[0].args.batchNumber);
        const resTxData = resDeposit.logs[0].args.txData;
        const resLoadAmount = BigInt(resDeposit.logs[0].args.loadAmount);
        const resEthAddress = BigInt(resDeposit.logs[0].args.ethAddress).toString();
        const resAx = BigInt(resDeposit.logs[0].args.Ax).toString(16);
        const resAy = BigInt(resDeposit.logs[0].args.Ay).toString(16);
        const txData = rollupUtils.decodeTxData(resTxData);
        
        // Get onChainHash calculated by smart contract
        const onChainSm = await insRollupTest.getFillingOnChainTxsHash();

        // forge genesis block
        const blockGenesis = await rollupDB.buildBlock(maxTx, nLevels);
        await blockGenesis.build();
        const input0 = buildInputSm(blockGenesis, beneficiary);

        await insRollupTest.forgeBatchTest(input0.oldStateRoot, input0.newStateRoot, input0.newExitRoot,
            input0.onChainHash, input0.feePlan, input0.compressedTx, input0.offChainHash, input0.nTxPerToken,
            input0.beneficiary);
        await rollupDB.consolidate(blockGenesis);

        // Forge block with deposit transacction
        const bb = await rollupDB.buildBlock(maxTx, nLevels);
        bb.addTx({
            fromIdx: txData.fromId,
            loadAmount: resLoadAmount,
            coin: txData.tokenId,
            ax: resAx,
            ay: resAy,
            ethAddress: resEthAddress,
            onChain: true,
        });
        await bb.build();
        expect(onChainSm.toString()).to.be.equal(bb.getOnChainHash().toString());
        await rollupDB.consolidate(bb);
        const input1 = buildInputSm(bb, beneficiary);
        await insRollupTest.forgeBatchTest(input1.oldStateRoot, input1.newStateRoot, input1.newExitRoot,
            input1.onChainHash, input1.feePlan, input1.compressedTx, input1.offChainHash, input1.nTxPerToken,
            input1.beneficiary);
        
        expect(resBatchNumber.add(BigInt(2)).toString()).to.be.equal(rollupDB.lastBlock.toString());

        // console.log("1 leaf", rollupDB.db.nodes);
    });

    it("Deposit on top and forge it", async () => {
        // const fromId = 1;
        // const onTopAmount = 5;
        // const tokenId = 0;
        // const nonce = 0;

        // const resApprove = await insTokenRollup.approve(insRollupTest.address, onTopAmount, { from: id1 });
        // expect(resApprove.logs[0].event).to.be.equal("Approval");

        // const resDepositonTop = await insRollupTest.depositOnTop(fromId, onTopAmount, tokenId,
        //     nonce, { from: id1, value: web3.utils.toWei("1", "ether") });
        // expect(resDepositonTop.logs[0].event).to.be.equal("OnChainTx");

        // // Check token balances for id1 and rollup smart contract
        // const resRollup = await insTokenRollup.balanceOf(insRollupTest.address);
        // const resId1 = await insTokenRollup.balanceOf(id1);
        // expect(resRollup.toString()).to.be.equal("15");
        // expect(resId1.toString()).to.be.equal("35");

        // // Get event 'OnChainTx' data
        // const resBatchNumber = BigInt(resDepositonTop.logs[0].args.batchNumber);
        // const resTxData = resDepositonTop.logs[0].args.txData;
        // const resLoadAmount = BigInt(resDepositonTop.logs[0].args.loadAmount);
        // const resEthAddress = BigInt(resDepositonTop.logs[0].args.ethAddress).toString();
        // const resAx = BigInt(resDepositonTop.logs[0].args.Ax).toString(16);
        // const resAy = BigInt(resDepositonTop.logs[0].args.Ay).toString(16);
        // const txData = rollupUtils.decodeTxData(resTxData);
        // console.log(txData);
        // console.log(rollupUtils.decodeTxData("0x0018000000000000000000000000000000000000000000010000000000000000"));
        // console.log("Check0", resTxData);
        // console.log("Check1", "0x0018000000000000000000000000000000000000000000010000000000000000");
        // // forge block with no tx
        // const bb0 = await rollupDB.buildBlock(maxTx, nLevels);
        // await bb0.build();
        // const input0 = buildInputSm(bb0, beneficiary);

        // await insRollupTest.forgeBatchTest(input0.oldStateRoot, input0.newStateRoot, input0.newExitRoot,
        //     input0.onChainHash, input0.feePlan, input0.compressedTx, input0.offChainHash, input0.nTxPerToken,
        //     input0.beneficiary);
        // await rollupDB.consolidate(bb0);
        // // forge block with deposit on top transacction
        // const bb1 = await rollupDB.buildBlock(maxTx, nLevels);
        
        // bb1.addTx({
        //     fromIdx: txData.fromId,
        //     toIdx: txData.toId,
        //     loadAmount: resLoadAmount,
        //     coin: txData.tokenId,
        //     ax: resAx,
        //     ay: resAy,
        //     ethAddress: resEthAddress,
        //     onChain: true,
        // });
        // await bb1.build();
        // await rollupDB.consolidate(bb1);
        // const input1 = buildInputSm(bb1, beneficiary);
        // console.log("BO");
        // await insRollupTest.forgeBatchTest(input1.oldStateRoot, input1.newStateRoot, input1.newExitRoot,
        //     input1.onChainHash, input1.feePlan, input1.compressedTx, input1.offChainHash, input1.nTxPerToken,
        //     input1.beneficiary);
        // expect(resBatchNumber.add(BigInt(2)).toString()).to.be.equal(rollupDB.lastBlock.toString());
    });

    it("force withdraw and forge it", async () => {
        // console.log("still 1 leaf", rollupDB.db.nodes);
    });

    it("fill addresses with rollup token, deposit on rollup and update balance tree", async () => {

    });

    it("simulate off-chain transacction with fee and forge batch", async () => {

    });

    it("simulate withdraw off-chain transacction and forge batch", async () => {

    });

    it("withdraw on-chain transaction", async () => {

    });
});