pragma solidity ^0.5.1;

import "../RollupPoS.sol";

contract RollupPoSTest is RollupPoS {

    constructor( address _rollup) RollupPoS(_rollup) public {}

    uint public blockNumber;

    function getBlockNumber() public view returns (uint) {
        return blockNumber;
    }

    function setBlockNumber(uint bn) public {
        blockNumber = bn;
    }

    function setBlockForged(uint32 slot) public {
        fullFilled[slot] = true;
    }

    function getRaffleWinnerTest(uint32 slot, uint64 luckyNumber) public view returns (uint32 winner) {
        // No negative era
        uint32 era = slot / SLOTS_PER_ERA;

        // Only accept raffle for present and past eras
        require (era <= currentEra()+1, "No access to not done raffles");

        uint32 ri;
        if (raffles[era].era == era) {
            ri = era;
        } else if (era > lastInitializedRaffle) {
            ri = lastInitializedRaffle;
        } else {
            require(false, "Raffle not initialized for that era");
        }

        Raffle storage raffle = raffles[ri];

        // Must be stakers
        require(raffle.activeStake > 0, "Must be stakers");

        // If only one staker, just return it
        if (operators.length == 1) return 0;

        // Do the raffle
        uint64 rnd = luckyNumber % raffle.activeStake;
        winner = nodeRaffle(raffle.root, rnd);
    }

    function getNode(uint32 idNode) public view returns (
        uint32 era,
        uint64 threashold,
        uint64 increment,
        bool isOpLeft,
        uint32 left,
        bool isOpRight,
        uint32 right
    ) {
        IntermediateNode memory N = nodes[idNode];
        return (
          N.era,
          N.threashold,
          N.increment,
          N.isOpLeft,
          N.left,
          N.isOpRight,
          N.right
        );
    }

    function getTreeLen() public view returns (uint256 era) {
        return nodes.length;
    }

    function getRaffle(uint32 eraIndex) public view returns (
        uint32 era,
        uint32 root,
        uint64 historicStake,
        uint64 activeStake,
        bytes8 seedRnd
    ) {
        Raffle memory raffleTest = raffles[eraIndex];
        return (
          raffleTest.era,
          raffleTest.root,
          raffleTest.historicStake,
          raffleTest.activeStake,
          raffleTest.seedRnd
        );
    }

    function forgeCommitedBatch(
        uint[2] calldata proofA,
        uint[2][2] calldata proofB,
        uint[2] calldata proofC,
        uint[8] calldata input
    ) external {
        uint32 slot = currentSlot();
        uint opId = getRaffleWinner(slot);
        Operator storage op = operators[opId];
        // Check that operator has commited data
        require(commitSlot[slot].commited == true, 'There is no commited data');
        // update previous hash commited by the operator
        op.rndHash = commitSlot[slot].previousHash;
        // clear commited data
        commitSlot[slot].commited = false;
        // one block has been forged in this slot
        fullFilled[slot] = true;
    }
}