// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Local drill fixture. Only the ERC-20 calls used by Aqua's transfer check are implemented.
contract MockKRWS {
    string public constant name = "Aqua Local Test Won";
    string public constant symbol = "MockKRWS";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address recipient, uint256 value) external returns (bool) {
        require(recipient != address(0));
        balanceOf[msg.sender] -= value;
        balanceOf[recipient] += value;
        emit Transfer(msg.sender, recipient, value);
        return true;
    }
}
