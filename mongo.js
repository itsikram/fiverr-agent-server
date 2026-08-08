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
DEFAULT_MONGO_URI).
trim();

const connectionOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 20000,
  retryWrites: true,
  appName: "fiverr-agent-mongo",
  tls: true
};

function hasSrvFallbackError(error) {
  return (
    error?.code === "ECONNREFUSED" && /querySrv/i.test(error?.message || ""));

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

  const auth = url.username ?
  `${encodeURIComponent(url.username)}${
  url.password ? `:${encodeURIComponent(url.password)}` : ""}@` :

  "";

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
  searchString ? `?${searchString}` : ""}`;

}

async function connectDB() {
  try {



    await mongoose.connect(MONGO_URI, connectionOptions);

  } catch (error) {
    if (MONGO_URI.startsWith("mongodb+srv://") && hasSrvFallbackError(error)) {



      try {
        const fallbackUri = await createFallbackUriFromSrv(MONGO_URI);
        const safeFallbackUri = fallbackUri.replace(
          /(mongodb:\/\/)([^:]+):([^@]+)@/,
          "$1$2:*****@"
        );

        await mongoose.connect(fallbackUri, connectionOptions);

        return;
      } catch (fallbackError) {




      }
    }


    process.exit(1);
  }
}

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      unique: true
    },
    role: {
      type: String,
      default: "user"
    }
  },
  {
    timestamps: true,
    collection: "users"
  }
);

const User = mongoose.model("User", userSchema);

async function createUser() {
  try {
    await connectDB();

    const user = await User.create({
      name: "John Doe",
      email: "john@example.com"
    });


  } catch (error) {

  } finally {
    await mongoose.disconnect();
  }
}

createUser();