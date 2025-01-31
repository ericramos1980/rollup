/* eslint-disable no-underscore-dangle */
/* eslint-disable no-await-in-loop */
/* global artifacts */
/* global contract */
/* global web3 */

const chai = require("chai");

const { expect } = chai;
const RollupPoS = artifacts.require("../contracts/test/RollupPoSTest");

async function getEtherBalance(address) {
    let balance = await web3.eth.getBalance(address);
    balance = web3.utils.fromWei(balance, "ether");
    return Number(balance);
}

// async function getTxGasSpent(resTx) {
//   const infoTx = await web3.eth.getTransaction(resTx.tx);
//   const { gasPrice } = infoTx;
//   const gasSpent = gasPrice * resTx.receipt.gasUsed;
//   return Number(web3.utils.fromWei(gasSpent.toString(), 'ether'));
// }

contract("RollupPoS", (accounts) => {
    const {
        6: relayStaker,
        7: beneficiaryAddress,
        9: slashAddress,
    } = accounts;

    let insRollupPoS;

    const addressRollupTest = "0x0000000000000000000000000000000000000001";
    const operators = [];
    const eraBlock = [];
    const eraSlot = [];
    const deadlineBlockPerSlot = [];
    const hashChain = [];
    const blockPerEra = 2000;
    const slotPerEra = 20;
    const blocksPerSlot = blockPerEra / slotPerEra;
    const deadlineBlocks = 80;
    let amountToStake = 2;

    const initialMsg = "rollup";
    hashChain.push(web3.utils.keccak256(initialMsg));
    for (let i = 1; i < 10; i++) {
        hashChain.push(web3.utils.keccak256(hashChain[i - 1]));
    }

    before(async () => {
    // Deploy token test
        insRollupPoS = await RollupPoS.new(addressRollupTest);
        // Initialization
        // fill with first block of each era
        const genesisBlockNum = await insRollupPoS.genesisBlock();
        for (let i = 0; i < 20; i++) {
            eraBlock.push(i * blockPerEra + Number(genesisBlockNum) + 1);
            eraSlot.push(i * slotPerEra);
            deadlineBlockPerSlot.push(Number(genesisBlockNum) + (i * blocksPerSlot) + deadlineBlocks);
        }
        // fill 5 addresses for operators
        for (let i = 1; i < 6; i++) {
            operators.push({ address: accounts[i], idOp: (i - 1).toString() });
        }
        // set first era block
        await insRollupPoS.setBlockNumber(eraBlock[0]);
    });

    describe("functionalities", () => {
        it("add operator", async () => {
            let initBalOp = await getEtherBalance(operators[0].address);
            // add operator 0 with eStake = 4
            await insRollupPoS.addOperator(hashChain[9],
                { from: operators[0].address, value: web3.utils.toWei(amountToStake.toString(), "ether") });
            const balOpAdd = await getEtherBalance(operators[0].address);
            expect(Math.ceil(balOpAdd)).to.be.equal(Math.ceil(initBalOp) - 2);
            // get back stake
            await insRollupPoS.setBlockNumber(eraBlock[3]);
            // try to get back stake from different operator
            try {
                await insRollupPoS.removeOperator(operators[0].idOp, { from: operators[1].address });
            } catch (error) {
                expect((error.message).includes("Sender does not match with operator controller")).to.be.equal(true);
            }
            initBalOp = await getEtherBalance(operators[0].address);
            await insRollupPoS.removeOperator(operators[0].idOp, { from: operators[0].address });

            // Era to remove operator
            await insRollupPoS.setBlockNumber(eraBlock[4]);
            try {
                await insRollupPoS.withdraw(0);
            } catch (error) {
                expect((error.message).includes("Era to withdraw after current era")).to.be.equal(true);
            }
            // Era to remove operator
            await insRollupPoS.setBlockNumber(eraBlock[5]);
            await insRollupPoS.withdraw(0);

            const balOpWithdraw = await getEtherBalance(operators[0].address);
            expect(Math.ceil(initBalOp)).to.be.equal(Math.ceil(balOpWithdraw) - 2);
        });

        it("add operator with different beneficiary address", async () => {
            const initBalance = await getEtherBalance(beneficiaryAddress);
            await insRollupPoS.setBlockNumber(eraBlock[5]);
            // add operator 1 with eStake = 4
            await insRollupPoS.addOperatorWithDifferentBeneficiary(beneficiaryAddress, hashChain[9],
                { from: operators[1].address, value: web3.utils.toWei(amountToStake.toString(), "ether") });
            await insRollupPoS.setBlockNumber(eraBlock[6]);
            await insRollupPoS.removeOperator(1, { from: operators[1].address });
            await insRollupPoS.setBlockNumber(eraBlock[8]);
            await insRollupPoS.withdraw(1);
            // Check balance beneficiary Address
            const balance = await getEtherBalance(beneficiaryAddress);
            expect(initBalance + 2).to.be.equal(balance);
        });

        it("add operator with different beneficiary address and relay staker", async () => {
            const initBalanceRelay = await getEtherBalance(relayStaker);
            const initBalOp = await getEtherBalance(operators[2].address);
            const initBalBeneficiary = await getEtherBalance(beneficiaryAddress);
            await insRollupPoS.setBlockNumber(eraBlock[8]);
            // add operator 2 with stakerAddress commiting 2 ether
            await insRollupPoS.addOperatorRelay(operators[2].address, beneficiaryAddress, hashChain[9],
                { from: relayStaker, value: web3.utils.toWei(amountToStake.toString(), "ether") });

            const balanceRelay0 = await getEtherBalance(relayStaker);
            const balOp0 = await getEtherBalance(operators[2].address);
            const balBeneficiary0 = await getEtherBalance(beneficiaryAddress);
            // check balances of all addresses
            expect(Math.ceil(initBalanceRelay) - 2).to.be.equal(Math.ceil(balanceRelay0));
            expect(initBalOp).to.be.equal(balOp0);
            expect(initBalBeneficiary).to.be.equal(balBeneficiary0);
            // sign ethereum message and build signature
            const hashMsg = web3.utils.soliditySha3("RollupPoS", "remove", { type: "uint32", value: operators[2].idOp });
            const sigOp = await web3.eth.sign(hashMsg, operators[2].address);
            const r = sigOp.substring(0, 66);
            const s = `0x${sigOp.substring(66, 130)}`;
            const v = Number(sigOp.substring(130, 132)) + 27;
            // remove operator and withdraw
            await insRollupPoS.setBlockNumber(eraBlock[7]);
            await insRollupPoS.removeOperatorRelay(operators[2].idOp, r, s, v.toString());
            await insRollupPoS.setBlockNumber(eraBlock[9]);
            await insRollupPoS.withdraw(operators[2].idOp);
            // check
            const balanceRelay1 = await getEtherBalance(relayStaker);
            const balOp1 = await getEtherBalance(operators[2].address);
            const balBeneficiary1 = await getEtherBalance(beneficiaryAddress);
            expect(balanceRelay0).to.be.equal(balanceRelay1);
            expect(balOp1).to.be.equal(balOp1);
            expect(balBeneficiary0 + 2).to.be.equal(balBeneficiary1);
        });

        it("slash operator", async () => {
            amountToStake = 20;
            const initBalOp = await getEtherBalance(operators[0].address);
            const initBalanceSlash = await getEtherBalance(slashAddress);
            // reset rollup PoS
            insRollupPoS = await RollupPoS.new(addressRollupTest);
            await insRollupPoS.setBlockNumber(eraBlock[0]);
            await insRollupPoS.addOperator(hashChain[9],
                { from: operators[0].address, value: web3.utils.toWei(amountToStake.toString(), "ether") });
            await insRollupPoS.setBlockNumber(eraBlock[1]);
            try {
                await insRollupPoS.slash(eraSlot[2], { from: slashAddress });
            } catch (error) {
                expect((error.message).includes("Slot requested still does not exist")).to.be.equal(true);
            }
            try {
                await insRollupPoS.slash(eraSlot[0], { from: slashAddress });
            } catch (error) {
                expect((error.message).includes("Must be stakers")).to.be.equal(true);
            }
            await insRollupPoS.setBlockNumber(eraBlock[3]);
            // Check balances before slashing
            let balOp = await getEtherBalance(operators[0].address);
            let balSlash = await getEtherBalance(slashAddress);

            expect(Math.ceil(initBalOp)).to.be.equal(Math.ceil(balOp) + amountToStake);
            expect(Math.ceil(initBalanceSlash)).to.be.equal(Math.ceil(balSlash));

            await insRollupPoS.slash(eraSlot[2], { from: slashAddress });
            // Check balances after slashing
            balOp = await getEtherBalance(operators[0].address);
            balSlash = await getEtherBalance(slashAddress);
            // operator 1 lose its amount staked
            expect(Math.ceil(initBalOp)).to.be.equal(Math.ceil(balOp) + amountToStake);
            // slash account to receive 10% of amount staked
            expect(Math.ceil(initBalanceSlash) + 0.1 * amountToStake).to.be.equal(Math.ceil(balSlash));

            // Add operator again
            await insRollupPoS.addOperator(hashChain[9],
                { from: operators[0].address, value: web3.utils.toWei(amountToStake.toString(), "ether") });
            await insRollupPoS.setBlockNumber(eraBlock[6]);
            // simulate operator has forge a batch
            await insRollupPoS.setBlockForged(eraSlot[5]);
            // try to slash operator
            try {
                await insRollupPoS.slash(eraSlot[5], { from: slashAddress });
            } catch (error) {
                expect((error.message).includes("Batch has been commited and forged during this slot")).to.be.equal(true);
            }
        });

        it("commit and forge batch", async () => {
            const compressedTxTest = "0x010203040506070809";
            const proofA = ["0", "0"];
            const proofB = [["0", "0"], ["0", "0"]];
            const proofC = ["0", "0"];
            const input = ["0", "0", "0", "0", "0", "0", "0", "0"];
            // reset rollup PoS
            insRollupPoS = await RollupPoS.new(addressRollupTest);
            await insRollupPoS.setBlockNumber(eraBlock[0]);
            await insRollupPoS.addOperator(hashChain[9],
                { from: operators[0].address, value: web3.utils.toWei(amountToStake.toString(), "ether") });
            await insRollupPoS.setBlockNumber(eraBlock[1]);
            await insRollupPoS.setBlockNumber(eraBlock[3]);
            // try to commit batch with wrong previous hash
            try {
                await insRollupPoS.commitBatch(hashChain[7], compressedTxTest);
            } catch(error) {
                expect((error.message).includes("hash revelead not match current commited hash")).to.be.equal(true);
            }
            // check commit bash
            const resCommit = await insRollupPoS.commitBatch(hashChain[8], compressedTxTest);
            expect(resCommit.logs[0].event).to.be.equal("dataCommited");
            expect(resCommit.logs[0].args.slot.toString()).to.be.equal(eraSlot[3].toString());
            expect(resCommit.logs[0].args.blockNumber.toString()).to.be.equal(eraBlock[3].toString());
            expect(resCommit.logs[0].args.compressedTx).to.be.equal(compressedTxTest);
            // try to update data commited before without forging
            try {
                await insRollupPoS.commitBatch(hashChain[8], compressedTxTest);
            } catch(error) {
                expect((error.message).includes("there is data which is not forged")).to.be.equal(true);
            }
            
            // Forge batch
            await insRollupPoS.forgeCommitedBatch(proofA, proofB, proofC, input);

            // try to forge data where there is no data commited
            try {
                await insRollupPoS.forgeCommitedBatch(proofA, proofB, proofC, input);
            } catch (error) {
                expect((error.message).includes("There is no commited data")).to.be.equal(true);
            }

            // commit data just before deadline
            await insRollupPoS.setBlockNumber(eraBlock[3] + deadlineBlocks - 2);
            await insRollupPoS.commitBatch(hashChain[7], compressedTxTest);
            await insRollupPoS.forgeCommitedBatch(proofA, proofB, proofC, input);

            // try to commit just after the deadline
            await insRollupPoS.setBlockNumber(eraBlock[3] + deadlineBlocks + 1);
            try { 
                await insRollupPoS.commitBatch(hashChain[6], compressedTxTest);
            } catch (error) {
                expect((error.message).includes("not possible to commit data afer deadline")).to.be.equal(true);
            }

            // move forward just one slot
            await insRollupPoS.setBlockNumber(eraBlock[3] + blocksPerSlot);
            // try to slash operator
            try {
                await insRollupPoS.slash(eraSlot[3]);
            } catch(error) {
                expect((error.message).includes("Batch has been commited and forged during this slot")).to.be.equal(true);
            }

            // commit data before deadline, try to update it, not forge block and slash operator
            // commit and forge
            await insRollupPoS.commitBatch(hashChain[6], compressedTxTest);
            await insRollupPoS.forgeCommitedBatch(proofA, proofB, proofC, input);
            // commit again but not forge
            await insRollupPoS.commitBatch(hashChain[5], compressedTxTest);
            // move forward and try to update commited info
            await insRollupPoS.setBlockNumber(eraBlock[3] + blocksPerSlot + deadlineBlocks);
            try {
                await insRollupPoS.commitBatch(hashChain[5], compressedTxTest);
            } catch(error) {
                expect((error.message).includes("not possible to commit data afer deadline")).to.be.equal(true);
            }
            // move formward next slot without forging
            await insRollupPoS.setBlockNumber(eraBlock[3] + 2*blocksPerSlot);
            // slash operator despite a block has been forged
            // but it commited data and has not forge commited data
            try {
                await insRollupPoS.slash(eraSlot[3]);
            } catch(error) {
                expect((error.message).includes("Batch has been commited and forged during this slot")).to.be.equal(true);
            }
            await insRollupPoS.slash(eraSlot[3] + 1);
            // move forward and be sure that there are no operators
            await insRollupPoS.setBlockNumber(eraBlock[5]);
            try {
                await insRollupPoS.getRaffleWinner(eraSlot[3]);
            } catch (error) {
                expect((error.message).includes("Must be stakers")).to.be.equal(true);
            }
        });

        it("slash operator with no commitment data", async () => {
            // reset rollup PoS
            insRollupPoS = await RollupPoS.new(addressRollupTest);
            await insRollupPoS.setBlockNumber(eraBlock[0]);
            await insRollupPoS.addOperator(hashChain[9],
                { from: operators[0].address, value: web3.utils.toWei(amountToStake.toString(), "ether") });
            await insRollupPoS.setBlockNumber(eraBlock[1]);
            await insRollupPoS.setBlockNumber(eraBlock[3]);
            // Balance before slashing
            const initBalSlash = await getEtherBalance(slashAddress);
            // slash operator 
            await insRollupPoS.slash(eraSlot[2], { from: slashAddress });
            // balance after slash operator
            const balSlash = await getEtherBalance(slashAddress);
            expect(Math.ceil(initBalSlash) + 0.1 * amountToStake).to.be.equal(Math.ceil(balSlash));
            // Assure no operators after slashing
            await insRollupPoS.setBlockNumber(eraBlock[5]);
            try {
                await insRollupPoS.getRaffleWinner(eraSlot[3]);
            } catch (error) {
                expect((error.message).includes("Must be stakers")).to.be.equal(true);
            }
        });
    });
});
