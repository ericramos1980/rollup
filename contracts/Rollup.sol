
pragma solidity ^0.5.0;

import '../node_modules/openzeppelin-solidity/contracts/ownership/Ownable.sol';
import './lib/RollupHelpers.sol';
import './RollupInterface.sol';
import './VerifierInterface.sol';

/**
 * @dev Define interface ERC20 contract
 */
contract ERC20 {
  function transfer(address recipient, uint256 amount) external returns (bool);
  function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

contract Rollup is Ownable, RollupHelpers, RollupInterface {

  // External contracts used
  VerifierInterface verifier;

  // Forge batch mechanism owner
  address ownerForgeBatch;

  // Each batch forged will have the root state of the 'balance tree'
  bytes32[] stateRoots;

  // Each batch forged will have a correlated 'exit tree' represented by the exit root
  bytes32[] exitRoots;
  mapping(uint256 => bool) exitNullifier;

  // Maxim Deposit allowed
  uint constant MAX_AMOUNT_DEPOSIT = (1 << 128);

  // List of valid ERC20 tokens that can be deposit in 'balance tree'
  address[] tokens;
  mapping(uint => address) tokenList;
  uint constant MAX_TOKENS = 0xFFFF;
  uint feeAddToken = 0.01 ether;

  // Set the leaf position for an account into the 'balance tree'
  // '0' is reserved for off-chain withdraws
  uint24 lastBalanceTreeIndex = 1;

  // Hash of all on chain transmissions ( will be forged in the next batch )
  // Forces 'operator' to add all on chain transmission
  uint256 miningOnChainTxsHash;

  // Hash of all on chain transmissions ( will be forged in two batches )
  // Forces 'operator' to add all on chain transmissions
  uint256 fillingOnChainTxsHash;

  // Fees of all on-chain transactions for the operator that forge that batch
  uint256 totalMinningOnChainFee;
  // Fees of all on-chain transactions for the operator
  uint256 totalFillingOnChainFee;

  // Fees recollected for every on-chain transaction
  uint constant FEE_ONCHAIN_TX = 0.1 ether;

  // maximum on-chain transactions
  uint constant MAX_ONCHAIN_TX = 100;
  // current on chain transactions
  uint currentOnChainTx = 0;

  /**
   * @dev Event called when a deposit has been made
   * contains all data required for the operator to:
   * add leaf to balance tree
   * off-chain transaction
   */
  event Deposit(uint idBalanceTree, uint depositAmount, uint tokenId, uint Ax, uint Ay,
    address withdrawAddress );

  /**
   * @dev Event called when a batch is forged
   * Contains all off-chain transaction compressed
   */
  event ForgeBatch(uint batchNumber, bytes offChainTx);

  /**
   * @dev Event called when a user makes a force withdraw
   * contains all data required for the operator to add the transaction
   */
  event ForceFullWithdraw(uint idBalanceTree, uint amount, uint tokenId, uint Ax, uint Ay,
    address withdrawAddress, uint nonce);

  /**
   * @dev Event called when a deposit on top is done
   * Contains all data required by the operator to do:
   * deposit on balance tree leaf
   */
  event DepositOnTop(uint idBalanceTree, uint amountDeposit);

  /**
   * @dev Event called when a token is added to token list
   * Contains token address and its index inside rollup token list
   */
  event AddToken(address tokenAddress, uint tokenId);

  // Flag to determine if the mechanism to forge batch has been initialized
  bool initialized = false;

  /**
   * @dev modifier to check if forge batch mechanism has been initialized
   */
  modifier isForgeBatch {
    require(initialized == true, 'forge batch mechanism has not been loaded');
    require(ownerForgeBatch == msg.sender, 'message sender is not forge batch mechanism owner');
    _;
  }

  /**
   * @dev Rollup constructor
   * Loads 'RollupHelpers' constructor with poseidon
   * Loads verifier zk-snark proof
   * @param _verifier verifier zk-snark proof address
   * @param _poseidon poseidon hash function address
   */
  constructor(address _verifier, address _poseidon) RollupHelpers(_poseidon) public {
    verifier = VerifierInterface(_verifier);
  }

  /**
   * @dev Load forge batch mechanism smart contract
   * @param forgeBatchMechanismAddress rollupPoS contract address
   */
  function loadForgeBatchMechanism(address forgeBatchMechanismAddress) public onlyOwner{
    ownerForgeBatch = forgeBatchMechanismAddress;
    initialized = true;
  }

  /**
   * @dev Inclusion of a new token that will be able to deposit on 'balance tree'
   * Fees to include token are increased as tokens are added into rollup
   * @param tokenAddress smart contract token address
   */
  function addToken(address tokenAddress) public payable {
    // Allow MAX_TOKENS different types of tokens
    require(tokens.length <= MAX_TOKENS, 'token list is full');
    require(msg.value >= feeAddToken, 'Amount is not enough to cover token fees');
    uint tokenId = tokens.push(tokenAddress) - 1;
    tokenList[tokenId] = tokenAddress;
    // increase fees for next token deposit
    feeAddToken = feeAddToken * 2;
    emit AddToken(tokenAddress, tokenId);
  }

  /**
   * @dev Deposit on-chain transaction to enter balance tree
   * @param depositAmount initial balance on balance tree
   * @param tokenId token type identifier
   * @param babyPubKey public key babyjub represented as point (Ax, Ay)
   * @param withdrawAddress allowed address to perform withdraw on-chain transaction
   */
  function deposit(
      uint16 depositAmount,
      uint16 tokenId,
      uint256[2] memory babyPubKey,
      address withdrawAddress
  ) public payable {

    require(msg.value >= FEE_ONCHAIN_TX, 'Amount deposited less than fee required');
    require(depositAmount > 0, 'Deposit amount must be greater than 0');
    require(withdrawAddress != address(0), 'Must specify withdraw address');
    require(tokenList[tokenId] != address(0), 'token has not been registered');
    require(currentOnChainTx < MAX_ONCHAIN_TX, 'Reached maximum number of on-chain transactions');
    require(depositAmount < MAX_AMOUNT_DEPOSIT, 'deposit amount larger than the maximum allowed');
    // Build entry deposit and get its hash
    Entry memory depositEntry = buildEntryDeposit(lastBalanceTreeIndex, depositAmount,
      tokenId, babyPubKey[0], babyPubKey[1], withdrawAddress, 0);
    uint256 hashDeposit = hashEntry(depositEntry);

    // Update 'fillingOnChainHash'
    uint256[] memory inputs = new uint256[](2);
    inputs[0] = fillingOnChainTxsHash;
    inputs[1] = hashDeposit;
    fillingOnChainTxsHash = hashGeneric(inputs);

    // Get token deposit on rollup smart contract
    require(depositToken(tokenId, depositAmount), 'Fail deposit ERC20 transaction');

    // Update total on-chain fees
    totalFillingOnChainFee += msg.value;

    // Update number of on-chain transactions
    currentOnChainTx++;

    emit Deposit(lastBalanceTreeIndex, depositAmount, tokenId, babyPubKey[0], babyPubKey[1],
      withdrawAddress);
    lastBalanceTreeIndex++;
  }

  /**
   * @dev Checks proof given by the operator
   * forge a batch if succesfull and pay fees to beneficiary address
   * @param beneficiaryAddress address to receive all fees
   * @param proofA zk-snark input
   * @param proofB zk-snark input
   * @param proofC zk-snark input
   * @param input public zk-snark inputs
   * @param compressedTxs data availability to maintain 'balance tree'
   */
  function forgeBatch(
    address payable beneficiaryAddress,
    uint[2] calldata proofA,
    uint[2][2] calldata proofB,
    uint[2] calldata proofC,
    uint[8] calldata input,
    bytes calldata compressedTxs
  ) external isForgeBatch {
    // Public parameters of the circuit
    // input[0] ==> old state root
    // input[1] ==> new state root
    // input[2] ==> new exit root
    // input[3] ==> on chain hash
    // input[4] ==> off chain hash
    // input[5] ==> fee plan[0]
    // input[6] ==> fee plan[1]
    // input[7] ==> nTxperToken

    // If there is no roots commited it means that it will be the genesis block
    if (stateRoots.length == 0) {
      require(bytes32(input[0]) == bytes32(0), 'old state root does not match current state root');
    } else {
      // Verify old state roots
      require(bytes32(input[0]) == stateRoots[stateRoots.length - 1], 'old state root does not match current state root');
    }

    // Verify on-chain hash
    require(input[3] == miningOnChainTxsHash, 'on-chain hash does not match current filling on-chain hash');

    // Verify all off-chain are commited on the public zk-snark input
    uint256 offChainTxHash = hashOffChainTx(compressedTxs);
    require(offChainTxHash == input[4], 'off chain tx does not match its public hash');

    // Verify zk-snark circuit
    require(verifier.verifyProof(proofA, proofB, proofC, input) == true, 'zk-snark proof is not valid');

    // Calculate fees and pay them
    bytes32[2] memory feePlan = [bytes32(input[5]), bytes32(input[6])];
    bytes32 nTxPerToken = bytes32(input[7]);

    for (uint i = 0; i < 16; i++) {
      uint tokenId;
      uint totalTokenFee;
      (tokenId, totalTokenFee) = calcTokenTotalFee(bytes32(feePlan[0]), bytes32(feePlan[1]),
        bytes32(nTxPerToken), i);

      if(totalTokenFee != 0) {
        require(withdrawToken(tokenId, beneficiaryAddress, totalTokenFee), 'Fail ERC20 withdraw');
      }
    }

    // Pay onChain transactions fees
    uint payOnChainFees = totalMinningOnChainFee;
    beneficiaryAddress.transfer(payOnChainFees);

    // Update state roots
    stateRoots.push(bytes32(input[1]));

    // Update exit roots
    exitRoots.push(bytes32(input[2]));

    // Clean fillingOnChainTxsHash an its fees
    miningOnChainTxsHash = fillingOnChainTxsHash;
    fillingOnChainTxsHash = 0;
    totalMinningOnChainFee = totalFillingOnChainFee;
    totalFillingOnChainFee = 0;

    // Update number of on-chain transactions
    currentOnChainTx = 0;

    // event with all compressed transactions given its batch number
    emit ForgeBatch(getStateDepth() - 1, compressedTxs);
  }

  /**
   * @dev withdraw on-chain transaction to get balance from balance tree
   * Before this call an off-chain withdraw transaction must be done
   * Off-chain withdraw transaction will build a leaf on exit tree
   * each batch forged will publish its exit tree root
   * All leaves created on the exit are allowed to call on-chain transaction to finish the withdraw
   * @param idBalanceTree account identifier on the balance tree
   * @param amount amount to retrieve
   * @param tokenId token type
   * @param numExitRoot exit root depth. Number of batch where the withdar transaction has been done
   * @param siblings siblings to demonstrate merkle tree proof
   */
  function withdraw(
      uint24 idBalanceTree,
      uint16 amount,
      uint16 tokenId,
      uint numExitRoot,
      uint256[] memory siblings
  ) public {

    // Build 'key' and 'value' for exit tree
    uint256 keyExitTree = idBalanceTree;
    Entry memory exitEntry = buildEntryExitLeaf(idBalanceTree, amount, tokenId, msg.sender);
    uint256 valueExitTree = hashEntry(exitEntry);

    // Get exit root given its index depth
    uint256 exitRoot = uint256(getExitRoot(numExitRoot));

    // Check exit tree nullifier
    uint256[] memory inputs = new uint256[](2);
    inputs[0] = exitRoot;
    inputs[1] = valueExitTree;
    uint256 nullifier = hashGeneric(inputs);
    require(exitNullifier[nullifier] == false, 'withdraw has been already done');

    // Check sparse merkle tree proof
    bool result = smtVerifier(exitRoot, siblings, keyExitTree, valueExitTree, 0, 0, false, false, 24);
    require(result == true, 'invalid proof');

    // Withdraw token from rollup smart contract to withdraw address
    require(withdrawToken(tokenId, msg.sender, amount), 'Fail ERC20 withdraw');

    // Set nullifier
    exitNullifier[nullifier] = true;
  }

  /**
   * @dev Withdraw all balance from balance tree
   * this withdraw mechanism consist only in a single on-chain transaction
   * user has to prove current state of balance tree, otherwise forceWithdraw can not be done
   * @param idBalanceTree account identifier on the balance tree
   * @param amount total amount
   * @param tokenId token type
   * @param babyPubKey public key babyjub represented as point (Ax, Ay)
   * @param nonce current value on last state root
   * @param siblings siblings to demonstrate merkle tree proof
   */
  function forceFullWithdraw(
      uint24 idBalanceTree,
      uint16 amount,
      uint16 tokenId,
      uint32 nonce,
      uint256[2] memory babyPubKey,
      uint256[] memory siblings
  ) public payable{

    require(msg.value >= FEE_ONCHAIN_TX, 'Amount deposited less than fee required');
    require(currentOnChainTx < MAX_ONCHAIN_TX, 'Reached maximum number of on-chain transactions');

    // build 'key' and 'value' for balance tree
    uint256 keyBalanceTree = idBalanceTree;
    Entry memory balanceEntry = buildEntryBalanceTree(amount, tokenId, babyPubKey[0],
      babyPubKey[1], msg.sender, nonce);
    uint256 valueBalanceTree = hashEntry(balanceEntry);

    // get current state root
    uint256 lastStateRoot = uint256(stateRoots[stateRoots.length - 1]);

    // Check sparse merkle tree proof
    bool result = smtVerifier(lastStateRoot, siblings, keyBalanceTree, valueBalanceTree, 0, 0, false, false, 24);
    require(result == true, 'invalid proof');

    // Update 'fillingOnChainHash'
    uint256[] memory inputs = new uint256[](2);
    inputs[0] = fillingOnChainTxsHash;
    inputs[1] = valueBalanceTree;
    fillingOnChainTxsHash = hashGeneric(inputs);

    // Update total on-chain fees
    totalFillingOnChainFee += msg.value;

    // Update number of on-chain transactions
    currentOnChainTx++;

    // Withdraw token from rollup smart contract to withdraw address
    require(withdrawToken(tokenId, msg.sender, amount), 'Fail ERC20 withdraw');

    // event force withdraw
    emit ForceFullWithdraw(idBalanceTree, amount, tokenId, babyPubKey[0], babyPubKey[1], msg.sender, nonce);
  }

  /**
   * @dev Deposit on an existing balance tree leaf
   * Sender must proof the existence of that leaf at any balance tree state
   * @param idBalanceTree account identifier on the balance tree
   * @param amount total amount
   * @param tokenId token type
   * @param withdrawAddress withdraw address
   * @param babyPubKey public key babyjub represented as point (Ax, Ay)
   * @param nonce current value on last state root
   * @param siblings siblings to demonstrate merkle tree proof
   * @param numStateRoot siblings to demonstrate merkle tree proof
   * @param amountDeposit amount to deposit on balance tree leaf
   */
  function depositOnTop(
      uint24 idBalanceTree,
      uint16 amount,
      uint16 tokenId,
      address withdrawAddress,
      uint32 nonce,
      uint256[2] memory babyPubKey,
      uint256[] memory siblings,
      uint256 numStateRoot,
      uint16 amountDeposit
  ) public payable{

    require(msg.value >= FEE_ONCHAIN_TX, 'Amount deposited less than fee required');
    require(currentOnChainTx < MAX_ONCHAIN_TX, 'Reached maximum number of on-chain transactions');
    require(amountDeposit < MAX_AMOUNT_DEPOSIT, 'deposit amount larger than the maximum allowed');
    // build 'key' and 'value' for balance tree
    uint256 keyBalanceTree = uint256(idBalanceTree);
    Entry memory balanceEntry = buildEntryBalanceTree(amount, tokenId, babyPubKey[0],
      babyPubKey[1], withdrawAddress, nonce);
    uint256 valueBalanceTree = hashEntry(balanceEntry);

    // get state root given its depth
    uint256 stateRoot = uint256(stateRoots[numStateRoot]);

    // Check sparse merkle tree proof
    bool result = smtVerifier(stateRoot, siblings, keyBalanceTree, valueBalanceTree, 0, 0, false, false, 24);
    require(result == true, 'invalid proof');

    // Update 'fillingOnChainHash'
    uint256[] memory inputs = new uint256[](2);
    inputs[0] = fillingOnChainTxsHash;
    inputs[1] = valueBalanceTree;
    fillingOnChainTxsHash = hashGeneric(inputs);

    // Update total on-chain fees
    totalFillingOnChainFee += msg.value;

    // Update number of on-chain transactions
    currentOnChainTx++;

    // Get token deposit on rollup smart contract
    require(depositToken(tokenId, amountDeposit), 'Fail deposit ERC20 transaction');

    // event deposit on top
    emit DepositOnTop(idBalanceTree, amountDeposit);
  }

  //////////////
  // Viewers
  /////////////

  /**
   * @dev Retrieve state root given its batch depth
   * @param numBatch batch depth
   * @return root
   */
  function getStateRoot(uint numBatch) public view returns (bytes32) {
    require(numBatch <= stateRoots.length - 1, 'Batch number does not exist');
    return stateRoots[numBatch];
  }

  /**
   * @dev Retrieve total number of batches forged
   * @return Total number of batches forged
   */
  function getStateDepth() public view returns (uint) {
    return stateRoots.length;
  }

  /**
   * @dev Retrieve exit root given its batch depth
   * @param numBatch batch depth
   * @return exit root
   */
  function getExitRoot(uint numBatch) public view returns (bytes32) {
    require(numBatch <= exitRoots.length - 1, 'Batch number does not exist');
    return exitRoots[numBatch];
  }

  /**
   * @dev Retrieve token address from its index
   * @param tokenId token id for rollup smart contract
   * @return token address
   */
  function getTokenAddress(uint tokenId) public view returns (address) {
    require(tokens.length > 0, 'There are no tokens listed');
    require(tokenId <= (tokens.length - 1), 'Token id does not exist');
    return tokenList[tokenId];
  }

  ///////////
  // helper ERC20 functions
  ///////////

  /**
   * @dev deposit token to rollup smart contract
   * Previously, it requires an approve erc20 transaction to allow this contract
   * make the transaction for the msg.sender
   * @param tokenId token id
   * @param amount quantity of token to send
   * @return true if succesfull
   */
  function depositToken(uint16 tokenId, uint16 amount) private returns(bool){
    return ERC20(tokenList[tokenId]).transferFrom(msg.sender, address(this), amount);
  }

  /**
   * @dev withdraw token from rollup smart contract
   * Tokens on rollup smart contract are withdrawn
   * @param tokenId token id
   * @param receiver address to receive amount
   * @param amount quantity to withdraw
   * @return true if succesfull
   */
  function withdrawToken(uint tokenId, address receiver, uint amount) private returns(bool){
    return ERC20(tokenList[tokenId]).transfer(receiver, amount);
  }
}