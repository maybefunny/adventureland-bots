import axios from "axios"
import fs from "fs"
import { ServerData, CharacterListData } from "./definitions/adventureland-server"
import { connect, disconnect } from "./database/database.js"
import { UserModel } from "./database/users/users.model.js"
import { IUserDocument } from "./database/users/users.types.js"
import { ServerRegion, ServerIdentifier, GData, CharacterType } from "./definitions/adventureland"
import { Ranger } from "./Ranger.js"
import { Observer } from "./Observer.js"
import { Player } from "./Player.js"
import { PingCompensatedPlayer } from "./PingCompensatedPlayer.js"
import { Mage } from "./Mage.js"
import { Merchant } from "./Merchant.js"
import { Priest } from "./Priest.js"
import { Warrior } from "./Warrior.js"

// TODO: Move to config file
export const MAX_PINGS = 100
export const PING_EVERY_MS = 30000
export const TIMEOUT = 1000

// Connect to Mongo
connect()

export class Game {
    protected static user: IUserDocument
    // TODO: Move this type to type definitions
    protected static servers: { [T in ServerRegion]?: { [T in ServerIdentifier]?: ServerData } } = {}
    // TODO: Move this type to type definitions
    protected static characters: { [T in string]?: CharacterListData } = {}

    public static players: { [T in string]: Player } = {}
    public static observers: { [T in string]: Observer } = {}

    public static G: GData

    private constructor() {
        // Private to force static methods
    }

    public static async disconnect(mongo = true): Promise<void> {
        // Stop all characters
        await this.stopAllCharacters()

        // Stop all observers
        await this.stopAllObservers()

        // Disconnect from the database
        if (mongo) disconnect()
    }

    static async getGData(): Promise<GData> {
        if (this.G) return this.G

        console.log("Updating 'G' data...")
        const response = await axios.get("http://adventure.land/data.js")
        if (response.status == 200) {
            // Update G with the latest data
            const matches = response.data.match(/var\s+G\s*=\s*(\{.+\});/)
            this.G = JSON.parse(matches[1]) as GData
            console.log("  Updated 'G' data!")
            return this.G
        } else {
            console.error(response)
            console.error("Error fetching http://adventure.land/data.js")
        }
    }

    static async login(email: string, password: string): Promise<boolean> {
        // See if we already have a userAuth stored in our database
        const user = await UserModel.findOne({ email: email, password: password }).exec()

        if (user) {
            console.log("Using authentication from database...")
            this.user = user
        } else {
            // Login and save the auth
            console.log("Logging in...")
            const login = await axios.post("https://adventure.land/api/signup_or_login", `method=signup_or_login&arguments={"email":"${email}","password":"${password}","only_login":true}`)
            let loginResult
            for (const datum of login.data) {
                if (datum.message) {
                    loginResult = datum
                    break
                }
            }
            if (loginResult && loginResult.message == "Logged In!") {
                console.log("  Logged in!")
                // We successfully logged in
                // Find the auth cookie and save it
                for (const cookie of login.headers["set-cookie"]) {
                    const result = /^auth=(.+?);/.exec(cookie)
                    if (result) {
                        // Save our data to the database
                        this.user = await UserModel.findOneAndUpdate({ email: email }, { password: password, userID: result[1].split("-")[0], userAuth: result[1].split("-")[1] }, { upsert: true, new: true, lean: true, useFindAndModify: true }).exec()
                        console.log(this.user)
                        break
                    }
                }
            } else if (loginResult && loginResult.message) {
                // We failed logging in, and we have a reason from the server
                console.error(loginResult.message)
                return Promise.reject(loginResult.message)
            } else {
                // We failed logging in, but we don't know what went wrong
                console.error(login.data)
                return Promise.reject()
            }
        }

        return this.updateServersAndCharacters()
    }

    static async loginJSONFile(path: string): Promise<boolean> {
        const data: { email: string, password: string } = JSON.parse(fs.readFileSync(path, "utf8"))
        return this.login(data.email, data.password)
    }

    static async startCharacter(cName: string, sRegion: ServerRegion, sID: ServerIdentifier, cType?: CharacterType): Promise<PingCompensatedPlayer> {
        if (!this.user) return Promise.reject("You must login first.")
        if (!this.characters) await this.updateServersAndCharacters()
        if (!this.G) await this.getGData()

        const userID = this.user.userID
        const userAuth = this.user.userAuth
        const characterID = this.characters[cName].id

        try {
            // Create the player and connect
            let player: PingCompensatedPlayer
            if (cType == "mage") player = new Mage(userID, userAuth, characterID, Game.G, this.servers[sRegion][sID])
            else if (cType == "merchant") player = new Merchant(userID, userAuth, characterID, Game.G, this.servers[sRegion][sID])
            else if (cType == "priest") player = new Priest(userID, userAuth, characterID, Game.G, this.servers[sRegion][sID])
            else if (cType == "ranger") player = new Ranger(userID, userAuth, characterID, Game.G, this.servers[sRegion][sID])
            else if (cType == "warrior") player = new Warrior(userID, userAuth, characterID, Game.G, this.servers[sRegion][sID])
            else player = new PingCompensatedPlayer(userID, userAuth, characterID, Game.G, this.servers[sRegion][sID])

            // Handle disconnects
            player.socket.on("disconnect", () => {
                Game.stopCharacter(cName)
            })

            await player.connect()

            this.players[cName] = player
            return player
        } catch (e) {
            return Promise.reject(e)
        }
    }

    static async startMage(cName: string, sRegion: ServerRegion, sID: ServerIdentifier): Promise<Mage> {
        return await Game.startCharacter(cName, sRegion, sID, "mage") as Mage
    }

    static async startMerchant(cName: string, sRegion: ServerRegion, sID: ServerIdentifier): Promise<Merchant> {
        return await Game.startCharacter(cName, sRegion, sID, "merchant") as Merchant
    }

    static async startPriest(cName: string, sRegion: ServerRegion, sID: ServerIdentifier): Promise<Priest> {
        return await Game.startCharacter(cName, sRegion, sID, "priest") as Priest
    }

    static async startRanger(cName: string, sRegion: ServerRegion, sID: ServerIdentifier): Promise<Ranger> {
        return await Game.startCharacter(cName, sRegion, sID, "ranger") as Ranger
    }

    static async startWarrior(cName: string, sRegion: ServerRegion, sID: ServerIdentifier): Promise<Warrior> {
        return await Game.startCharacter(cName, sRegion, sID, "warrior") as Warrior
    }

    static async startObserver(region: ServerRegion, id: ServerIdentifier): Promise<Observer> {
        try {
            const g = await Game.getGData()
            const observer = new Observer(this.servers[region][id], g, true)
            await observer.connect()

            this.observers[this.servers[region][id].key] = observer
            return observer
        } catch (e) {
            return Promise.reject(e)
        }
    }

    static async stopAllCharacters(): Promise<void> {
        for (const characterName in this.players) await this.stopCharacter(characterName)
    }

    static async stopAllObservers(): Promise<void> {
        for (const region in this.observers)
            for (const id in this.observers[region])
                await this.stopObserver(region as ServerRegion, id as ServerIdentifier)
    }

    public static async stopCharacter(characterName: string): Promise<void> {
        if (!this.players[characterName]) return
        await this.players[characterName].disconnect()
        delete this.players[characterName]
    }

    public static async stopObserver(region: ServerRegion, id: ServerIdentifier): Promise<void> {
        this.observers[this.servers[region][id].key].socket.close()
        this.observers[this.servers[region][id].key].socket.removeAllListeners()
        delete this.observers[region][id]
    }

    static async updateServersAndCharacters(): Promise<boolean> {
        const data = await axios.post("http://adventure.land/api/servers_and_characters", "method=servers_and_characters&arguments={}", { headers: { "cookie": `auth=${this.user.userID}-${this.user.userAuth}` } })

        if (data.status == 200) {
            // Populate server information
            for (const serverData of data.data[0].servers as ServerData[]) {
                if (!this.servers[serverData.region]) this.servers[serverData.region] = {}
                this.servers[serverData.region][serverData.name] = serverData
            }

            // Populate character information
            for (const characterData of data.data[0].characters as CharacterListData[]) {
                this.characters[characterData.name] = characterData
            }

            return Promise.resolve(true)
        } else {
            console.error(data)
        }

        return Promise.reject("Error fetching http://adventure.land/api/servers_and_characters")
    }
}