// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Orbyt Badges
/// @notice Achievement badges for the Orbyt / Mello game collection.
///         - Soulbound: badges can be minted and burned (by their owner) but never transferred or sold.
///         - One of each badge per wallet.
///         - Only the game server (MINTER_ROLE) can award; players never pay gas.
///         - No cash value, no supply caps to speculate on, no royalties.
contract OrbytBadges is ERC1155, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string public constant name = "Orbyt Badges";
    string public constant symbol = "ORBYT";

    string private baseUri;   // e.g. https://api.example/api/base/badge/  (id + ".json" is appended)

    error Soulbound();
    error AlreadyAwarded(address to, uint256 id);

    event Awarded(address indexed to, uint256 indexed id);

    constructor(address admin, address minter, string memory baseUri_) ERC1155("") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        baseUri = baseUri_;
    }

    /// @notice Award one badge. Reverts if the wallet already holds it.
    function award(address to, uint256 id) external onlyRole(MINTER_ROLE) {
        if (balanceOf(to, id) != 0) revert AlreadyAwarded(to, id);
        _mint(to, id, 1, "");
        emit Awarded(to, id);
    }

    /// @notice Award several badges in one transaction; ones the wallet already holds are skipped.
    function awardBatch(address to, uint256[] calldata ids) external onlyRole(MINTER_ROLE) {
        for (uint256 i = 0; i < ids.length; i++) {
            if (balanceOf(to, ids[i]) != 0) continue;
            _mint(to, ids[i], 1, "");
            emit Awarded(to, ids[i]);
        }
    }

    /// @notice A holder can always get rid of a badge they no longer want.
    function burn(uint256 id) external {
        _burn(msg.sender, id, 1);
    }

    function uri(uint256 id) public view override returns (string memory) {
        return string.concat(baseUri, Strings.toString(id), ".json");
    }

    function setBaseUri(string calldata u) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseUri = u;
        emit URI(u, 0);
    }

    // ---------------------------------------------------------------- soulbound
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0)) revert Soulbound();
        super._update(from, to, ids, values);
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
