"use strict";
const env = require("dotenv");
const result = env.config();

if (result.error) {
  throw result.error;
}

const ethers = require("ethers");
const retry = require("async-retry");
const pcsAbi = new ethers.Interface(require("./abi.json"));

const token = process.env.TARGET_TOKEN;

// ERC20 ABI
const abiERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

const tokens = {
  router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", // uniswapV3Router
  purchaseAmount: process.env.PURCHASEAMOUNT || "0.01",
  pair: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token], // trading pair, WETH/<quote>
  GASLIMIT: process.env.GASLIMIT || "1000000",
  GASPRICE: process.env.GASPRICE || "5",
  buyDelay: 1,
  buyRetries: 3,
  retryMinTimeout: 250,
  retryMaxTimeout: 3000,
  deadline: 60,
};

const purchaseAmount = ethers.parseUnits(tokens.purchaseAmount, "ether");
const EXPECTED_PONG_BACK = 30000;
const KEEP_ALIVE_CHECK_INTERVAL = 15000;

let pingTimeout = null;
let keepAliveInterval = null;
let provider;
let wallet;
let account;
let router;
let grasshopper;

const GLOBAL_CONFIG = {
  NODE_WSS: process.env.NODE_WSS,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  RECIPIENT: process.env.RECIPIENT,
};

if (!token) {
  throw "No token has been specified. Please specify in .env.";
}

if (!GLOBAL_CONFIG.PRIVATE_KEY) {
  throw "The private key was not found in .env. Enter the private key in .env.";
}

if (!GLOBAL_CONFIG.RECIPIENT) {
  throw "The public address (RECIPIENT) was not found in .env. Enter your public address in .env.";
}

async function Wait(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

const startConnection = () => {
  provider = new ethers.WebSocketProvider(GLOBAL_CONFIG.NODE_WSS);
  wallet = new ethers.Wallet(GLOBAL_CONFIG.PRIVATE_KEY);
  account = wallet.connect(provider);
  router = new ethers.Contract(tokens.router, pcsAbi, account);
  grasshopper = 0;

  provider.websocket.on("open", () => {
    console.log(`Sniping has started. Watching the txpool for events for token ${token}...`);
    tokens.router = ethers.getAddress(tokens.router);
    keepAliveInterval = setInterval(() => {
      provider.websocket.ping();
      pingTimeout = setTimeout(() => {
        provider.websocket.terminate();
      }, EXPECTED_PONG_BACK);
    }, KEEP_ALIVE_CHECK_INTERVAL);

    provider.on("pending", async (txHash) => {
      provider
        .getTransaction(txHash)
        .then(async (tx) => {
          if (grasshopper === 0) {
            console.log("Still watching... Please wait.");
            grasshopper = 1;
          }
          if (tx && tx.to) {
            if (tx.to === tokens.router) {
              // const re1 = new RegExp("^0xf305d719");
              // if (re1.test(tx.data)) {
              //   const decodedInput = pcsAbi.parseTransaction({
              //     data: tx.data,
              //     value: tx.value,
              //   });
              //   console.log(decodedInput);
              //   if (ethers.getAddress(pair[1]) === decodedInput.args[0]) {
              //     provider.off("pending");
              //     await Wait(tokens.buyDelay);
              //     await BuyToken(tx);
              //   }
              // }
              // Get data slice in Hex
              const dataSlice = ethers.hexDataSlice(tx.data, 4);

              // Ensure desired data length
              if (tx.data.length === 522) {
                // Decode data
                const decoded = ethers.defaultAbiCoder.decode(
                  ["address", "address", "uint24", "address", "uint256", "uint256", "uint256", "uint160"],
                  dataSlice
                );

                // Log decoded data
                console.log("");
                console.log("Open Transaction: ", tx.hash);
                console.log(decoded);

                // Interpret data - Contracts
                const contract0 = new ethers.Contract(decoded[0], abiERC20, provider);
                const contract1 = new ethers.Contract(decoded[1], abiERC20, provider);

                // Interpret data - Symbols
                const symbol0 = await contract0.symbol();
                const symbol1 = await contract1.symbol();

                // Interpret data - Decimals
                const decimals0 = await contract0.decimals();
                const decimals1 = await contract1.decimals();

                // Interpret data - Values
                const amountOut = Number(ethers.utils.formatUnits(decoded[5], decimals1));

                // Interpret data - Values
                const amountInMax = Number(ethers.utils.formatUnits(decoded[6], decimals0));

                // Readout
                console.log("symbol0: ", symbol0, decimals0);
                console.log("symbol1: ", symbol1, decimals1);
                console.log("amountOut: ", amountOut);
                console.log("amountInMax: ", amountInMax);
              }
            }
          }
        })
        .catch(() => {});
    });
  });

  provider.websocket.on("close", () => {
    console.log("WebSocket Closed. Reconnecting...");
    clearInterval(keepAliveInterval);
    clearTimeout(pingTimeout);
    startConnection();
  });

  provider.websocket.on("error", () => {
    console.log("Error. Attemptiing to Reconnect...");
    clearInterval(keepAliveInterval);
    clearTimeout(pingTimeout);
    startConnection();
  });

  provider.websocket.on("pong", () => {
    clearInterval(pingTimeout);
  });
};

const BuyToken = async (txLP) => {
  const tx = await retry(
    async () => {
      const amountOutMin = 0;
      let buyConfirmation = await router.swapExactETHForTokens(
        amountOutMin,
        tokens.pair,
        process.env.RECIPIENT,
        Date.now() + 1000 * tokens.deadline,
        {
          value: tokens.purchaseAmount,
          gasLimit: tokens.gasLimit,
          gasPrice: ethers.utils.parseUnits(tokens.gasPrice, "gwei"),
        }
      );
      return buyConfirmation;
    },
    {
      retries: tokens.buyRetries,
      minTimeout: tokens.retryMinTimeout,
      maxTimeout: tokens.retryMaxTimeout,
      onRetry: (err, number) => {
        console.log("Buy Failed - Retrying", number);
        console.log("Error", err);
        if (number === tokens.buyRetries) {
          console.log("Sniping has failed...");
          process.exit();
        }
      },
    }
  );
  console.log("Associated LP Event txHash: " + txLP.hash);
  console.log("Your [pending] txHash: " + tx.hash);
  process.exit();
};
startConnection();
