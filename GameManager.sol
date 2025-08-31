// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/**
 * GameManager for Battle Royale style game using YNGG (ERC20) as entry/reward token.
 *
 * Basic flow:
 *  - Owner creates a match with params (matchId, maxPlayers, entryFee)
 *  - Players call joinMatch(matchId) after approving GameManager to spend entryFee
 *  - Game operator (owner) can start the match (optional) and later call distributeReward(matchId, winner)
 *  - distributeReward transfers accumulated prizePool to winner and marks match finished
 *
 * SECURITY NOTES:
 *  - Winner distribution is authorized by owner (game operator). If you want trustless winner selection,
 *    use signed proofs or an oracle / on-chain RNG + dispute mechanism (not included).
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

contract GameManager {
    address public owner;
    IERC20 public YNGG; // token used as entry fee & reward

    enum MatchState { Created, Started, Finished, Cancelled }

    struct Match {
        bytes32 id;
        address[] players;
        uint256 maxPlayers;
        uint256 entryFee; // in token's smallest unit
        uint256 prizePool;
        MatchState state;
        mapping(address => bool) isJoined;
    }

    // mapping matchIdHash => Match
    mapping(bytes32 => Match) private matches;
    mapping(bytes32 => bool) private matchExists;

    event MatchCreated(bytes32 indexed matchId, uint256 maxPlayers, uint256 entryFee);
    event PlayerJoined(bytes32 indexed matchId, address indexed player);
    event MatchStarted(bytes32 indexed matchId);
    event WinnerDeclared(bytes32 indexed matchId, address indexed winner, uint256 amount);
    event MatchCancelled(bytes32 indexed matchId);
    event OwnerWithdraw(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier matchActive(bytes32 matchId) {
        require(matchExists[matchId], "match not exists");
        require(matches[matchId].state != MatchState.Finished && matches[matchId].state != MatchState.Cancelled, "match not active");
        _;
    }

    constructor(address ynggAddress) {
        require(ynggAddress != address(0), "invalid token");
        owner = msg.sender;
        YNGG = IERC20(ynggAddress);
    }

    // Create a new match. matchKey is any identifier string (e.g. "room-123"), we store as hash.
    function createMatch(string calldata matchKey, uint256 maxPlayers, uint256 entryFee) external onlyOwner {
        require(maxPlayers >= 2, "min players 2");
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(!matchExists[mId], "match exists");

        Match storage m = matches[mId];
        m.id = mId;
        m.maxPlayers = maxPlayers;
        m.entryFee = entryFee;
        m.prizePool = 0;
        m.state = MatchState.Created;
        matchExists[mId] = true;

        emit MatchCreated(mId, maxPlayers, entryFee);
    }

    // Player joins a match by transferring entryFee tokens to this contract.
    function joinMatch(string calldata matchKey) external {
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(matchExists[mId], "match not exists");
        Match storage m = matches[mId];
        require(m.state == MatchState.Created, "join closed");
        require(m.players.length < m.maxPlayers, "full");
        require(!m.isJoined[msg.sender], "already joined");

        // transfer tokens from player to contract
        if (m.entryFee > 0) {
            bool ok = YNGG.transferFrom(msg.sender, address(this), m.entryFee);
            require(ok, "token transfer failed");
            m.prizePool += m.entryFee;
        }

        m.players.push(msg.sender);
        m.isJoined[msg.sender] = true;

        emit PlayerJoined(mId, msg.sender);
    }

    // Owner can start the match (optional)
    function startMatch(string calldata matchKey) external onlyOwner {
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(matchExists[mId], "match not exists");
        Match storage m = matches[mId];
        require(m.state == MatchState.Created, "bad state");
        m.state = MatchState.Started;
        emit MatchStarted(mId);
    }

    // Owner declares a winner and distributes the prize pool to winner
    function distributeReward(string calldata matchKey, address winner) external onlyOwner {
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(matchExists[mId], "match not exists");
        Match storage m = matches[mId];
        require(m.state == MatchState.Started || m.state == MatchState.Created, "bad state");
        require(m.prizePool > 0, "no prize");

        // mark finished first (reentrancy safety pattern)
        m.state = MatchState.Finished;
        uint256 amount = m.prizePool;
        m.prizePool = 0;

        bool ok = YNGG.transfer(winner, amount);
        require(ok, "transfer failed");

        emit WinnerDeclared(mId, winner, amount);
    }

    // Owner can cancel match and refund players (if any)
    function cancelMatch(string calldata matchKey) external onlyOwner {
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(matchExists[mId], "match not exists");
        Match storage m = matches[mId];
        require(m.state != MatchState.Finished && m.state != MatchState.Cancelled, "bad state");

        m.state = MatchState.Cancelled;
        uint256 pool = m.prizePool;
        m.prizePool = 0;

        // refund players equally by their entry fee (simplest: transfer entryFee back to each joined player)
        // note: we assume entryFee * players.length == pool (no fees).
        for (uint i=0;i<m.players.length;i++){
            address p = m.players[i];
            if (p != address(0) && m.entryFee > 0){
                // ignore transfer failure to avoid blocking - emit event instead
                YNGG.transfer(p, m.entryFee);
            }
        }

        emit MatchCancelled(mId);
    }

    // Owner emergency withdraw tokens (only owner)
    function ownerWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero");
        bool ok = YNGG.transfer(to, amount);
        require(ok, "withdraw failed");
        emit OwnerWithdraw(to, amount);
    }

    // View helpers
    function getMatchInfo(string calldata matchKey) external view returns (
        bytes32 id,
        uint256 maxPlayers,
        uint256 currentPlayers,
        uint256 entryFee,
        uint256 prizePool,
        MatchState state
    ) {
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(matchExists[mId], "match not exists");
        Match storage m = matches[mId];
        id = m.id;
        maxPlayers = m.maxPlayers;
        currentPlayers = m.players.length;
        entryFee = m.entryFee;
        prizePool = m.prizePool;
        state = m.state;
    }

    function getPlayers(string calldata matchKey) external view returns (address[] memory){
        bytes32 mId = keccak256(abi.encodePacked(matchKey));
        require(matchExists[mId], "match not exists");
        return matches[mId].players;
    }
}
