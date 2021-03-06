import dotenv from "dotenv";
import axios from 'axios';
import { ethers } from 'ethers';

import { logger } from "../logger";
import { insertLeaf } from "../merkle-tree/leaves";
import { shieldContract } from "../tx-manager";
import { merkleTrees } from "../db/models/MerkleTree";

dotenv.config();

const newLeafEvent = ethers.utils.id("NewLeaf(uint256,bytes32,bytes32)");
let ws_provider;

export const http_provider = new ethers.providers.JsonRpcProvider(process.env.ETH_CLIENT_HTTP);
export const get_ws_provider = () => {
  if (!ws_provider) {
    try {
      ws_provider = new ethers.providers.WebSocketProvider(process.env.ETH_CLIENT_WS);
      ws_provider._websocket.on("error", (error) => {
        logger.error(`[WEBSOCKET] "error" event: ${error.stack}`);
        ws_provider = undefined;
      });
      ws_provider._websocket.on("close", (event) => {
        logger.error(`[WEBSOCKET] "close" event: ${event}`);
        ws_provider = undefined;
      });
      logger.info(`Established websocket connection: ${process.env.ETH_CLIENT_WS}`);
    } catch (err) {
      logger.error(`[WEBSOCKET] Cannot establish connection: ${process.env.ETH_CLIENT_WS}`);
    }
  }
  return ws_provider;
}

export const subscribeMerkleEvents = (contractAddress) => {
  logger.info(`Creating event listeners for contract: ${contractAddress}`);

  const singleLeafFilter = {
    address: contractAddress,
    topics: [newLeafEvent]
  }

  const contractInterface = new ethers.utils.Interface(shieldContract.abi);
  const provider = get_ws_provider();
  if (!provider) {
    error = {
      code: -32603,
      message: `WEBSOCKET: could not establish connection`,
      data: `Attempted endpoint: ${process.env.ETH_CLIENT_WS}`
    };
    return error;
  }

  provider.on(singleLeafFilter, async (result) => {
    logger.info(`NewLeaf event emitted for contract: ${contractAddress}`);

    const txLogs = contractInterface.parseLog(result);
    const leafIndex = txLogs.args[0].toNumber();
    const leafValue = txLogs.args[1];
    const onchainRoot = txLogs.args[2];
    logger.info(`New on-chain root: ${onchainRoot}`);

    const leaf = {
      value: leafValue,
      leafIndex: leafIndex,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber
    }
    await insertLeaf(contractAddress, leaf);
  });
}

export const unsubscribeMerkleEvents = (contractAddress) => {
  logger.info(`Removing event listeners for contract: ${contractAddress}`);
  const singleLeafFilter = {
    address: contractAddress,
    topics: [newLeafEvent]
  }

  const provider = get_ws_provider();
  provider.off(singleLeafFilter);
}

// Meant to be called everytime this commit-mgr service is restarted
export const restartSubscriptions = async () => {
  const activeTrees = await merkleTrees.find({
    _id: { $regex: /_0$/ },
    active: true
  });

  // For all 'active' MerkleTrees, search through old logs for any 
  // newLeaf events we missed while service was offline. Then resubscribe
  // to the events.
  for (let i = 0; i < activeTrees.length; i++) {
    const contractAddress = activeTrees[i]._id.slice(0, -2);
    const fromBlock = activeTrees[i].latestLeaf ? activeTrees[i].latestLeaf.blockNumber : 0;
    await checkChainLogs(contractAddress, fromBlock);
    subscribeMerkleEvents(contractAddress);
  }
}

export const checkChainLogs = async (contractAddress, fromBlock) => {
  // If fromBlock is provided, check next block so we don't add a leaf that was already captured
  const blockNum = fromBlock ? fromBlock + 1 : 0;
  logger.info(`Checking chain logs for missed newLeaf events starting at block ${fromBlock} for contract: ${contractAddress}`);
  // besu has a bug where 'eth_getLogs' expects 'fromBlock' to be a string instead of integer
  const convertedBlockNum = process.env.ETH_CLIENT_TYPE === "besu" ? `${blockNum}` : blockNum;
  const params = {
    fromBlock: convertedBlockNum,
    toBlock: "latest",
    address: contractAddress,
    topics: [newLeafEvent]
  };
  const res = await jsonrpc('eth_getLogs', [params]);
  const logs = res.result;

  const contractInterface = new ethers.utils.Interface(shieldContract.abi);

  for (let i = 0; i < logs.length; i++) {
    const txLogs = contractInterface.parseLog(logs[i]);
    const leafIndex = txLogs.args[0].toNumber();
    const leafValue = txLogs.args[1];
    logger.info(`Found previously missed leaf index ${leafIndex} of value ${leafValue}`);

    const leaf = {
      value: leafValue,
      leafIndex: leafIndex,
      transactionHash: logs[i].transactionHash,
      blockNumber: logs[i].blockNumber
    }
    await insertLeaf(contractAddress, leaf);
  }
}

export const jsonrpc = async (method, params, id) => {
  const response = await axios.post(process.env.ETH_CLIENT_HTTP, {
    jsonrpc: "2.0",
    id: id || 1,
    method: method,
    params: params
  });
  return response.data;
}
