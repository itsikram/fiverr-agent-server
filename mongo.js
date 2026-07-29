import dotenv from "dotenv";
import mongoose from "mongoose";
import { Resolver, promises as dnsPromises } from "dns";

dotenv.config();

const DEFAULT_MONGO_URI =
  "mongodb+srv://testmailbd2026_db_user:BgAEQdfgnmdSuZKp@cluster0.gwqnbsp.mongodb.net/fiverr_agent?appName=Cluster0";

const MONGO_URI = (
  process.env.MONGODB_URI ||
  process.env.MONGODB_URL ||
  process.env.mongodb_url ||
  DEFAULT_MONGO_URI
).trim();

const connectionOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 20000,
  retryWrites: true,
  appName: "fiverr-agent-mongo",
  tls: true,
};

function hasSrvFallbackError(error) {
  return (
    error?.code === "ECONNREFUSED" && /querySrv/i.test(error?.message || "")
  );
}

async function createFallbackUriFromSrv(uri) {
  const url = new URL(uri);
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);

  const searchParams = new URLSearchParams(url.searchParams);
  if (!searchParams.has("tls") && !searchParams.has("ssl")) {
    searchParams.set("tls", "true");
  }
  if (!searchParams.has("retryWrites")) {
    searchParams.set("retryWrites", "true");
  }
  if (!searchParams.has("authSource")) {
    searchParams.set("authSource", "admin");
  }

  const auth = url.username
    ? `${encodeURIComponent(url.username)}${
        url.password ? `:${encodeURIComponent(url.password)}` : ""
      }@`
    : "";

  const srvRecords = await new Promise((resolve, reject) => {
    resolver.resolveSrv(`_mongodb._tcp.${url.hostname}`, (err, records) => {
      if (err) {
        reject(err);
      } else {
        resolve(records);
      }
    });
  });

  const hosts = srvRecords.map((record) => `${record.name}:${record.port}`);
  const dbName = url.pathname?.slice(1) || "";
  const searchString = searchParams.toString();

  return `mongodb://${auth}${hosts.join(",")}/${dbName}${
    searchString ? `?${searchString}` : ""
  }`;
}

async function connectDB() {
  try {
    console.log(
      `Connecting to MongoDB using URI type: ${MONGO_URI.startsWith("mongodb+srv://") ? "SRV" : "standard"}`,
    );
    await mongoose.connect(MONGO_URI, connectionOptions);
    console.log("✅ Connected to MongoDB Atlas");
  } catch (error) {
    if (MONGO_URI.startsWith("mongodb+srv://") && hasSrvFallbackError(error)) {
      console.warn(
        "⚠️ SRV DNS lookup failed. Trying a direct host list fallback using public DNS resolver.",
      );
      try {
        const fallbackUri = await createFallbackUriFromSrv(MONGO_URI);
        const safeFallbackUri = fallbackUri.replace(
          /(mongodb:\/\/)([^:]+):([^@]+)@/,
          "$1$2:*****@",
        );
        console.log(`Fallback direct URI: ${safeFallbackUri}`);
        await mongoose.connect(fallbackUri, connectionOptions);
        console.log("✅ Connected to MongoDB Atlas using fallback direct URI");
        return;
      } catch (fallbackError) {
        console.error(
          "❌ Fallback direct URI connection failed:",
          fallbackError.message,
        );
      }
    }

    console.error("❌ Connection failed:", error.message);
    process.exit(1);
  }
}

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    role: {
      type: String,
      default: "user",
    },
  },
  {
    timestamps: true,
    collection: "users",
  },
);

const User = mongoose.model("User", userSchema);

async function createUser() {
  try {
    await connectDB();

    const user = await User.create({
      name: "John Doe",
      email: "john@example.com",
    });

    console.log("✅ User created:", user);
  } catch (error) {
    console.error(error);
  } finally {
    await mongoose.disconnect();
  }
}

createUser();
