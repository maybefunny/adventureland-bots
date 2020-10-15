import axios from "axios"
import socketio from "socket.io-client"
import { AchievementProgressData, CharacterData, ServerData, CharacterListData, ActionData, ChestOpenedData, DeathData, DisappearData, ChestData, EntitiesData, EvalData, GameResponseData, HitData, NewMapData, PartyData, StartData, WelcomeData, LoadedData, EntityData, PlayerData, AuthData, DisappearingTextData, GameLogData, UIData, UpgradeData, QData } from "./definitions/adventureland-server"
import { connect, disconnect } from "./database/database.js"
import { UserModel } from "./database/users/users.model.js"
import { IUserDocument } from "./database/users/users.types.js"
import { ServerRegion, ServerIdentifier, GData, SkillName, BankInfo, ConditionName, MapName, ItemInfo, ItemName, SlotType, MonsterName, CharacterType, SInfo, IPosition, NPCType, BankPackType, TradeSlotType } from "./definitions/adventureland"
import { Tools } from "./tools.js"
import { CharacterModel } from "./database/characters/characters.model.js"
import { Pathfinder } from "./pathfinder.js"
import { LinkData, NodeData } from "./definitions/pathfinder"
import { EntityModel } from "./database/entities/entities.model.js"
import { NPC_INTERACTION_DISTANCE, SPECIAL_MONSTERS } from "./constants.js"

// TODO: Move to config file
const MAX_PINGS = 100
const PING_EVERY_MS = 30000
const TIMEOUT = 1000

connect()

export class Observer {
    public socket: SocketIOClient.Socket

    public G: GData

    protected serverRegion: ServerRegion
    protected serverIdentifier: ServerIdentifier
    protected map: MapName
    protected x: number
    protected y: number

    constructor(serverData: ServerData, g: GData, reconnect = false) {
        this.serverRegion = serverData.region
        this.serverIdentifier = serverData.name
        this.G = g

        this.socket = socketio(`ws://${serverData.addr}:${serverData.port}`, {
            autoConnect: false,
            reconnection: reconnect,
            transports: ["websocket"]
        })

        this.socket.on("welcome", (data: WelcomeData) => {
            this.map = data.map
            this.x = data.x
            this.y = data.y

            // Send a response that we're ready to go
            this.socket.emit("loaded", {
                height: 1080,
                width: 1920,
                scale: 2,
                success: 1
            } as LoadedData)
        })

        this.socket.on("death", async (data: DeathData) => {
            try {
                await EntityModel.findOneAndDelete({ name: data.id }).exec()
            } catch (e) {
                // There probably wasn't an entity with that ID (this will happen a lot)
            }
        })

        this.socket.on("entities", (data: EntitiesData) => {
            this.parseEntities(data)
        })

        this.socket.on("new_map", (data: NewMapData) => {
            this.map = data.name
            this.x = data.x
            this.y = data.y
            this.parseEntities(data.entities)
        })

        let lastUpdate = Number.MIN_VALUE
        this.socket.on("server_info", async (data: SInfo) => {
            // Help out super in his data gathering
            if (Date.now() > lastUpdate - 10000) {
                lastUpdate = Date.now()
                const statuses: any[] = []
                for (const mtype in data) {
                    const info = data[mtype]
                    if (info.live && info.hp == undefined) {
                        info.hp = this.G.monsters[mtype as MonsterName].hp
                        info.max_hp = this.G.monsters[mtype as MonsterName].hp
                    }
                    if (typeof info == "object") {
                        statuses.push({
                            ...data[mtype],
                            eventname: mtype,
                            server_region: this.serverRegion,
                            server_identifier: this.serverIdentifier
                        })
                    }
                }
                for (const status of statuses) {
                    try {
                        await axios.post("https://aldata.info/api/serverstatus", status, {
                            headers: {
                                "content-type": "application/json"
                            }
                        })
                    } catch (e) { /* Supress Errors */ }
                }
            }

            for (const mtype in data) {
                const info = data[mtype as MonsterName]
                if (!info.live) {
                    EntityModel.deleteOne({ type: mtype as MonsterName, serverIdentifier: this.serverIdentifier, serverRegion: this.serverRegion }).exec()
                } else if (SPECIAL_MONSTERS.includes(mtype as MonsterName)) {
                    EntityModel.updateOne({ type: mtype as MonsterName, serverIdentifier: this.serverIdentifier, serverRegion: this.serverRegion }, {
                        map: info.map,
                        x: info.x,
                        y: info.y,
                        target: info.target,
                        serverRegion: this.serverRegion,
                        serverIdentifier: this.serverIdentifier,
                        lastSeen: Date.now(),
                        hp: info.hp,
                        type: mtype as MonsterName
                    }, { upsert: true, useFindAndModify: false }).exec()
                }
            }
        })
    }

    protected async parseEntities(data: EntitiesData): Promise<void> {
        // Update all the players
        for (const player of data.players) {
            if (player.npc) {
                // TODO: Update NPCs if they walk around
            } else {
                CharacterModel.updateOne({ name: player.id }, {
                    map: data.map,
                    name: player.id,
                    x: player.x,
                    y: player.y,
                    serverRegion: this.serverRegion,
                    serverIdentifier: this.serverIdentifier,
                    lastSeen: Date.now(),
                    s: player.s
                }, { upsert: true, useFindAndModify: false }).exec()
            }
        }

        // Update entities if they're special
        for (const entity of data.monsters) {
            if (!SPECIAL_MONSTERS.includes(entity.type)) continue

            EntityModel.updateOne({ type: entity.type, serverIdentifier: this.serverIdentifier, serverRegion: this.serverRegion }, {
                map: data.map,
                name: entity.id,
                x: entity.x,
                y: entity.y,
                target: entity.target,
                serverRegion: this.serverRegion,
                serverIdentifier: this.serverIdentifier,
                lastSeen: Date.now(),
                level: entity.level ? entity.level : 1,
                hp: entity.hp,
                type: entity.type
            }, { upsert: true, useFindAndModify: false }).exec()
        }
    }

    public async connect(): Promise<unknown> {
        console.log("Connecting...")
        const connected = new Promise<unknown>((resolve, reject) => {
            this.socket.on("welcome", (data: WelcomeData) => {
                if (data.region !== this.serverRegion || data.name !== this.serverIdentifier) {
                    reject(`We wanted the server ${this.serverRegion}${this.serverIdentifier}, but we are on ${data.region}${data.name}.`)
                }

                resolve()
            })

            setTimeout(() => {
                reject("Failed to start within 10s.")
            }, 10000)
        })

        this.socket.open()

        return connected
    }
}

export class Player extends Observer {
    protected userID: string
    protected userAuth: string
    protected characterID: string
    protected lastPositionUpdate: number
    protected promises: Promise<boolean>[] = []
    protected pingNum = 1
    protected pingMap = new Map<string, number>()
    protected timeouts = new Map<string, ReturnType<typeof setTimeout>>()

    public achievements = new Map<string, AchievementProgressData>()
    public bank: BankInfo = { gold: 0 }
    public character: CharacterData
    public chests = new Map<string, ChestData>()
    public entities = new Map<string, EntityData>()
    public nextSkill = new Map<SkillName, Date>()
    public party: PartyData
    public pings: number[] = []
    public players = new Map<string, PlayerData>()
    public projectiles = new Map<string, ActionData & { date: Date }>()
    public server: WelcomeData
    public S: SInfo

    constructor(userID: string, userAuth: string, characterID: string, g: GData, serverData: ServerData) {
        super(serverData, g)
        this.userID = userID
        this.userAuth = userAuth
        this.characterID = characterID

        this.socket.on("start", (data: StartData) => {
            // console.log("socket: start!")
            // console.log(data)
            this.parseCharacter(data)
            if (data.entities) this.parseEntities(data.entities)
            this.S = data.s_info
        })

        this.socket.on("achievement_progress", (data: AchievementProgressData) => {
            this.achievements.set(data.name, data)
            console.log(data)
        })

        this.socket.on("action", (data: ActionData) => {
            // TODO: do we need this 'date'?
            this.projectiles.set(data.pid, { ...data, date: new Date() })
        })

        // on("connect")

        this.socket.on("chest_opened", (data: ChestOpenedData) => {
            this.chests.delete(data.id)
        })

        this.socket.on("death", (data: DeathData) => {
            const entity = this.entities.get(data.id)

            // If it was a special monster in 'S', delete it from 'S'.
            if (this.S && entity && this.S[entity.type]) delete this.S[entity.type]

            this.entities.delete(data.id)
            // TODO: Does this get called for players, too? Players turn in to grave stones...
        })

        this.socket.on("disappear", (data: DisappearData) => {
            this.players.delete(data.id)
        })

        this.socket.on("disconnect", () => {
            // NOTE: We will try to automatically reconnect
            // this.disconnect()
        })

        this.socket.on("drop", (data: ChestData) => {
            this.chests.set(data.id, data)
        })

        this.socket.on("entities", (data: EntitiesData) => {
            this.parseEntities(data)
        })

        this.socket.on("eval", (data: EvalData) => {
            // Skill timeouts (like attack) are sent via eval
            const skillReg1 = /skill_timeout\s*\(\s*['"](.+?)['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.exec(data.code)
            if (skillReg1) {
                const skill = skillReg1[1] as SkillName
                let cooldown: number
                if (skillReg1[2]) {
                    cooldown = Number.parseFloat(skillReg1[2])
                } else if (this.G.skills[skill].cooldown) {
                    cooldown = this.G.skills[skill].cooldown
                }
                this.setNextSkill(skill, new Date(Date.now() + Math.ceil(cooldown)))
                return
            }

            // Potion timeouts are sent via eval
            const potReg = /pot_timeout\s*\(\s*(\d+\.?\d+?)\s*\)/.exec(data.code)
            if (potReg) {
                const cooldown = Number.parseFloat(potReg[1])
                this.setNextSkill("use_hp", new Date(Date.now() + Math.ceil(cooldown)))
                this.setNextSkill("use_mp", new Date(Date.now() + Math.ceil(cooldown)))
                return
            }
        })

        this.socket.on("game_error", (data: string | { message: string }) => {
            if (typeof data == "string") {
                console.error(`Game Error: ${data}`)
            } else {
                console.error("Game Error ----------")
                console.error(data)
            }
            this.disconnect()
        })

        this.socket.on("game_response", (data: GameResponseData) => {
            this.parseGameResponse(data)
        })

        this.socket.on("hit", (data: HitData) => {
            // console.log("socket: hit!")
            // console.log(data)
            if (data.miss || data.evade) {
                this.projectiles.delete(data.pid)
                return
            }

            if (data.reflect) {
                // TODO: Reflect!
                this.projectiles.get(data.pid)
            }

            if (data.kill == true) {
                this.projectiles.delete(data.pid)
                this.entities.delete(data.id)
            } else if (data.damage) {
                this.projectiles.delete(data.pid)
                const entity = this.entities.get(data.id)
                if (entity) {
                    entity.hp = entity.hp - data.damage
                    this.entities.set(data.id, entity)
                }
            }
        })

        this.socket.on("new_map", (data: NewMapData) => {
            this.projectiles.clear()

            this.parseEntities(data.entities)

            if (this.character) {
                this.character.x = data.x
                this.character.y = data.y
                this.character.in = data.in
                this.character.map = data.name
                this.character.m = data.m
            }
        })

        // TODO: Confirm this works for leave_party(), too.
        this.socket.on("party_update", (data: PartyData) => {
            this.party = data
        })

        this.socket.on("ping_ack", (data: { id: string }) => {
            if (this.pingMap.has(data.id)) {
                // Add the new ping
                const ping = Date.now() - this.pingMap.get(data.id)
                this.pings.push(ping)
                console.log(`Ping: ${ping}`)

                // Remove the oldest ping
                if (this.pings.length > MAX_PINGS) this.pings.shift()

                // Remove the ping from the map
                this.pingMap.delete(data.id)
            }
        })

        this.socket.on("player", (data: CharacterData) => {
            this.parseCharacter(data)
        })

        this.socket.on("q_data", (data: QData) => {
            if (data.q.upgrade) this.character.q.upgrade = data.q.upgrade
            if (data.q.compound) this.character.q.compound = data.q.compound
        })

        this.socket.on("server_info", (data: SInfo) => {
            // Add Soft properties
            for (const mtype in data) {
                if (typeof data[mtype] !== "object") continue
                const mN = mtype as MonsterName
                if (data[mN].live && data[mN].hp == undefined) {
                    data[mN].hp = this.G.monsters[mN].hp
                    data[mN].max_hp = this.G.monsters[mN].hp
                }
            }

            this.S = data
        })

        this.socket.on("upgrade", (data: UpgradeData) => {
            if (data.type == "compound" && this.character.q.compound) delete this.character.q.compound
            // else if (data.type == "exchange" && this.character.q.exchange) delete this.character.q.exchange
            else if (data.type == "upgrade" && this.character.q.upgrade) delete this.character.q.upgrade
        })

        this.socket.on("welcome", (data: WelcomeData) => {
            // console.log("socket: welcome!")
            this.server = data

            // Send a response that we're ready to go
            // console.log("socket: loaded...")
            this.socket.emit("loaded", {
                height: 1080,
                width: 1920,
                scale: 2,
                success: 1
            } as LoadedData)
        })
    }

    protected parseCharacter(data: CharacterData): void {
        this.map = data.map
        this.x = data.x
        this.y = data.y

        // Create the character if we don't have one
        if (!this.character) {
            this.character = data
            delete this.character["base_gold"]
            delete this.character["entities"]
            delete this.character["hitchhikers"]
            delete this.character["info"]
            delete this.character["s_info"]
            delete this.character["user"]

            // Add going_to variables
            this.character.going_x = data.x
            this.character.going_y = data.y
            this.character.moving = false
            this.character.damage_type = this.G.classes[data.ctype].damage_type
        }

        // Update all the character information we can
        for (const datum in data) {
            if (datum == "hitchhikers") {
                // Game responses
                for (const [event, datum] of data.hitchhikers) {
                    if (event == "game_response") {
                        this.parseGameResponse(datum)
                    }
                }
            } else if (datum == "moving") {
                // We'll handle moving...
            } else if (datum == "tp") {
                // We just teleported, but we don't want to keep the data.
            } else if (datum == "user") {
                // Bank information
                this.bank = data.user
            } else {
                // Normal attribute
                this.character[datum] = data[datum]
            }
        }
    }

    protected async parseEntities(data: EntitiesData): Promise<void> {
        super.parseEntities(data)

        if (data.type == "all") {
            // Erase all of the entities
            this.entities.clear()
            this.players.clear()
        } else if (this.character) {
            // Update all positions
            this.updatePositions()
        }

        for (const monster of data.monsters) {
            if (!this.entities.has(monster.id)) {
                // Set soft properties
                if (monster.level === undefined) monster.level = 1
                if (monster.max_hp === undefined) monster.max_hp = this.G.monsters[monster.type]["hp"]
                if (monster.max_mp === undefined) monster.max_mp = this.G.monsters[monster.type]["mp"]
                if (monster.map === undefined) monster.map = data.map

                if (monster["1hp"] === undefined) monster["1hp"] = this.G.monsters[monster.type]["1hp"]
                if (monster.apiercing === undefined) monster.apiercing = this.G.monsters[monster.type].apiercing
                if (monster.attack === undefined) monster.attack = this.G.monsters[monster.type].attack
                if (monster.cooperative === undefined) monster.cooperative = this.G.monsters[monster.type].cooperative
                if (monster.damage_type === undefined) monster.damage_type = this.G.monsters[monster.type].damage_type
                if (monster.evasion === undefined) monster.evasion = this.G.monsters[monster.type].evasion
                if (monster.frequency === undefined) monster.frequency = this.G.monsters[monster.type].frequency
                if (monster.hp === undefined) monster.hp = this.G.monsters[monster.type].hp
                if (monster.mp === undefined) monster.mp = this.G.monsters[monster.type].mp
                if (monster.range === undefined) monster.range = this.G.monsters[monster.type].range
                if (monster.reflection === undefined) monster.reflection = this.G.monsters[monster.type].reflection
                if (monster.speed === undefined) monster.speed = this.G.monsters[monster.type].speed
                if (monster.xp === undefined) monster.xp = this.G.monsters[monster.type].xp

                // Set everything else
                this.entities.set(monster.id, monster)
            } else {
                // Update everything
                const entity = this.entities.get(monster.id)
                for (const attr in monster) entity[attr] = monster[attr]
            }
        }
        for (const player of data.players) {
            if (player.id == this.character?.id) {
                // Update everything for our own player if we see it
                for (const datum in player) this.character[datum] = player[datum]
            } else {
                this.players.set(player.id, player)
            }
        }
    }

    protected parseGameResponse(data: GameResponseData): void {
        // Adjust cooldowns
        if (typeof (data) == "object") {
            if (data.response == "cooldown") {
                // A skill is on cooldown
                const skill = data.skill
                if (skill) {
                    const cooldown = data.ms
                    this.setNextSkill(skill, new Date(Date.now() + Math.ceil(cooldown)))
                }
            } else if (data.response == "ex_condition") {
                // The condition expired
                delete this.character.s[data.name]
            } else if (data.response == "skill_success") {
                const cooldown = this.G.skills[data.name].cooldown
                if (cooldown) {
                    this.setNextSkill(data.name, new Date(Date.now() + cooldown))
                }
            } else {
                // DEBUG
                console.info("Game Response Data -----")
                console.info(data)
            }
        } else if (typeof (data) == "string") {
            // DEBUG
            console.info(`Game Response: ${data}`)
        }
    }

    protected setNextSkill(skill: SkillName, next: Date): void {
        this.nextSkill.set(skill, next)
    }

    protected updatePositions(): void {
        if (this.lastPositionUpdate) {
            const msSinceLastUpdate = Date.now() - this.lastPositionUpdate

            // Update entities
            for (const entity of this.entities.values()) {
                if (!entity.moving) continue
                const distanceTravelled = entity.speed * msSinceLastUpdate / 1000
                const angle = Math.atan2(entity.going_y - entity.y, entity.going_x - entity.x)
                const distanceToGoal = Tools.distance({ x: entity.x, y: entity.y }, { x: entity.going_x, y: entity.going_y })
                if (distanceTravelled > distanceToGoal) {
                    entity.moving = false
                    entity.x = entity.going_x
                    entity.y = entity.going_y
                } else {
                    entity.x = entity.x + Math.cos(angle) * distanceTravelled
                    entity.y = entity.y + Math.sin(angle) * distanceTravelled
                }

                // Update conditions
                for (const condition in entity.s) {
                    const newCooldown = entity.s[condition as ConditionName].ms - msSinceLastUpdate
                    if (newCooldown <= 0) delete entity.s[condition as ConditionName]
                    else entity.s[condition as ConditionName].ms = newCooldown
                }
            }

            // Update players
            for (const player of this.players.values()) {
                if (!player.moving) continue
                const distanceTravelled = player.speed * msSinceLastUpdate / 1000
                const angle = Math.atan2(player.going_y - player.y, player.going_x - player.x)
                const distanceToGoal = Tools.distance({ x: player.x, y: player.y }, { x: player.going_x, y: player.going_y })
                if (distanceTravelled > distanceToGoal) {
                    player.moving = false
                    player.x = player.going_x
                    player.y = player.going_y
                } else {
                    player.x = player.x + Math.cos(angle) * distanceTravelled
                    player.y = player.y + Math.sin(angle) * distanceTravelled
                }

                // Update conditions
                for (const condition in player.s) {
                    const newCooldown = player.s[condition as ConditionName].ms - msSinceLastUpdate
                    if (newCooldown <= 0) delete player.s[condition as ConditionName]
                    else player.s[condition as ConditionName].ms = newCooldown
                }
            }

            // Update character
            if (this.character.moving) {
                const distanceTravelled = this.character.speed * msSinceLastUpdate / 1000
                const angle = Math.atan2(this.character.going_y - this.character.y, this.character.going_x - this.character.x)
                const distanceToGoal = Tools.distance({ x: this.character.x, y: this.character.y }, { x: this.character.going_x, y: this.character.going_y })
                if (distanceTravelled > distanceToGoal) {
                    this.character.moving = false
                    this.character.x = this.character.going_x
                    this.character.y = this.character.going_y
                } else {
                    this.character.x = this.character.x + Math.cos(angle) * distanceTravelled
                    this.character.y = this.character.y + Math.sin(angle) * distanceTravelled
                }
            }

            // Update conditions
            for (const condition in this.character.s) {
                const newCooldown = this.character.s[condition as ConditionName].ms - msSinceLastUpdate
                if (newCooldown <= 0) delete this.character.s[condition as ConditionName]
                else this.character.s[condition as ConditionName].ms = newCooldown
            }
        }

        // Erase all players and entities that are more than 600 units away
        let toDelete: string[] = []
        for (const [id, entity] of this.entities) {
            if (Tools.distance(this.character, entity) < 600) continue
            toDelete.push(id)
        }
        for (const id of toDelete) this.entities.delete(id)
        toDelete = []
        for (const [id, player] of this.players) {
            if (Tools.distance(this.character, player) < 600) continue
            toDelete.push(id)
        }
        for (const id of toDelete) this.players.delete(id)

        this.lastPositionUpdate = Date.now()
    }

    public async connect(): Promise<unknown> {
        const connected = new Promise<unknown>((resolve, reject) => {
            const failCheck = (data: string | { message: string }) => {
                if (typeof data == "string") {
                    reject(`Failed to connect: ${data}`)
                } else {
                    reject(`Failed to connect: ${data.message}`)
                }
            }

            const startCheck = () => {
                resolve()
            }


            setTimeout(() => {
                this.socket.removeListener("start", startCheck)
                this.socket.removeListener("game_error", failCheck)
                reject("Failed to start within 10s.")
            }, 10000)

            this.socket.once("start", startCheck)
            this.socket.once("game_error", failCheck)
        })

        // When we're loaded, authenticate
        this.socket.on("welcome", () => {
            // console.log("socket: authenticating...")
            this.socket.emit("auth", {
                auth: this.userAuth,
                character: this.characterID,
                height: 1080,
                no_graphics: "True",
                no_html: "1",
                passphrase: "",
                scale: 2,
                user: this.userID,
                width: 1920
            } as AuthData)
        })

        this.socket.open()

        return connected
    }

    public async disconnect(): Promise<void> {
        if (this.socket.disconnected) return
        console.warn("Disconnecting!")

        // Close the socket
        this.socket.close()

        // Cancel all timeouts
        for (const timer of this.timeouts.values()) clearTimeout(timer)
    }

    /**
     * This function is a hack to get the server to respond with a player data update. It will respond with two...
     */
    public async requestPlayerData(): Promise<CharacterData> {
        return new Promise((resolve, reject) => {
            const checkPlayerEvent = (data: CharacterData) => {
                if (data.s.typing) {
                    this.socket.removeListener("player", checkPlayerEvent)
                    resolve(data)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", checkPlayerEvent)
                reject(`requestPlayerData timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", checkPlayerEvent)

            this.socket.emit("property", { typing: true })
        })
    }

    // TODO: Convert to async, and return a promise<number> with the ping ms time
    public sendPing(): string {
        // Get the next pingID
        const pingID = this.pingNum.toString()
        this.pingNum++

        // Set the pingID in the map
        this.pingMap.set(pingID, Date.now())

        // Get the ping
        this.socket.emit("ping_trig", { id: pingID })
        return pingID
    }

    /**
     * Accepts a magiport reequest from another character
     * @param name ID of the character that offered a magiport.
     */
    public acceptMagiport(name: string): Promise<NodeData> {
        const acceptedMagiport = new Promise<NodeData>((resolve, reject) => {
            const magiportCheck = (data: NewMapData) => {
                if (data.effect == "magiport") {
                    this.socket.removeListener("new_map", magiportCheck)
                    resolve({ map: data.in, x: data.x, y: data.y })
                }
            }

            setTimeout(() => {
                this.socket.removeListener("new_map", magiportCheck)
                reject(`acceptMagiport timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("new_map", magiportCheck)
        })

        this.socket.emit("magiport", { name: name })
        return acceptedMagiport
    }

    /**
     * Accepts another character's party invite.
     * @param id The ID of the character's party you want to accept the invite for.
     */
    public acceptPartyInvite(id: string): Promise<PartyData> {
        const acceptedInvite = new Promise<PartyData>((resolve, reject) => {
            const partyCheck = (data: PartyData) => {
                if (data.list.includes(this.character.id)
                    && data.list.includes(id)) {
                    this.socket.removeListener("party_update", partyCheck)
                    this.socket.removeListener("game_log", unableCheck)
                    resolve(data)
                }
            }

            const unableCheck = (data: GameLogData) => {
                const notFound = RegExp("^.+? is not found$")
                if (data == "Invitation expired") {
                    this.socket.removeListener("party_update", partyCheck)
                    this.socket.removeListener("game_log", unableCheck)
                    reject(data)
                } else if (notFound.test(data)) {
                    this.socket.removeListener("party_update", partyCheck)
                    this.socket.removeListener("game_log", unableCheck)
                    reject(data)
                } else if (data == "Already partying") {
                    if (this.party.list.includes(this.character.id)
                        && this.party.list.includes(id)) {
                        // NOTE: We resolve the promise even if we have already accepted it if we're in the correct party.
                        this.socket.removeListener("party_update", partyCheck)
                        this.socket.removeListener("game_log", unableCheck)
                        resolve(this.party)
                    } else {
                        this.socket.removeListener("party_update", partyCheck)
                        this.socket.removeListener("game_log", unableCheck)
                        reject(data)
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("party_update", partyCheck)
                this.socket.removeListener("game_log", unableCheck)
                reject(`acceptPartyInvite timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("party_update", partyCheck)
            this.socket.on("game_log", unableCheck)
        })

        this.socket.emit("party", { event: "accept", name: id })
        return acceptedInvite
    }

    // TODO: Add failure checks
    public acceptPartyRequest(id: string): Promise<PartyData> {
        const acceptedRequest = new Promise<PartyData>((resolve, reject) => {
            const partyCheck = (data: PartyData) => {
                if (data.list.includes(this.character.id)
                    && data.list.includes(id)) {
                    this.socket.removeListener("party_update", partyCheck)
                    resolve(data)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("party_update", partyCheck)
                reject(`acceptPartyRequest timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("party_update", partyCheck)
        })

        this.socket.emit("party", { event: "raccept", name: id })
        return acceptedRequest
    }

    // TODO: Add 'notthere' (e.g. calling attack("12345") returns ["notthere", {place: "attack"}])
    // TODO: Check if cooldown is sent after attack
    public attack(id: string): Promise<string> {
        if (this.character.mp_cost > this.character.mp) return Promise.reject("Not enough MP to attack")

        const attackStarted = new Promise<string>((resolve, reject) => {
            const deathCheck = (data: DeathData) => {
                if (data.id == id) {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("game_response", failCheck)
                    this.socket.removeListener("death", deathCheck)
                    reject(`Entity ${id} not found`)
                }
            }
            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "disabled") {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Attack on ${id} failed (disabled).`)
                    } else if (data.response == "attack_failed" && data.id == id) {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Attack on ${id} failed.`)
                    } else if (data.response == "too_far" && data.id == id) {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`${id} is too far away to attack (dist: ${data.dist}).`)
                    } else if (data.response == "cooldown" && data.id == id) {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Attack on ${id} failed due to cooldown (ms: ${data.ms}).`)
                    } else if (data.response == "no_mp" && data.place == "attack") {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Attack on ${id} failed due to insufficient MP.`)
                    }
                }
            }
            const attackCheck = (data: ActionData) => {
                if (data.attacker == this.character.id && data.target == id && data.type == "attack") {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("game_response", failCheck)
                    this.socket.removeListener("death", deathCheck)
                    resolve(data.pid)
                }
            }
            setTimeout(() => {
                this.socket.removeListener("action", attackCheck)
                this.socket.removeListener("game_response", failCheck)
                this.socket.removeListener("death", deathCheck)
                reject(`attack timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", attackCheck)
            this.socket.on("game_response", failCheck)
            this.socket.on("death", deathCheck)
        })

        this.socket.emit("attack", { id: id })
        return attackStarted
    }

    // TODO: Return buy info
    public buy(itemName: ItemName, quantity = 1): Promise<number> {
        if (this.character.gold < this.G.items[itemName].g) return Promise.reject(`Insufficient gold. We have ${this.character.gold}, but the item costs ${this.G.items[itemName].g}`)

        const itemReceived = new Promise<number>((resolve, reject) => {
            const buyCheck1 = (data: CharacterData) => {
                if (!data.hitchhikers) return
                for (const hitchhiker of data.hitchhikers) {
                    if (hitchhiker[0] == "game_response") {
                        const data: GameResponseData = hitchhiker[1]
                        if (typeof data == "object"
                            && data.response == "buy_success"
                            && data.name == itemName
                            && data.q == quantity) {
                            this.socket.removeListener("player", buyCheck1)
                            this.socket.removeListener("game_response", buyCheck2)
                            resolve(data.num)
                        }
                    }
                }
            }
            const buyCheck2 = (data: GameResponseData) => {
                if (data == "buy_cant_npc") {
                    this.socket.removeListener("player", buyCheck1)
                    this.socket.removeListener("game_response", buyCheck2)
                    reject(`Cannot buy ${quantity} ${itemName}(s) from an NPC`)
                } else if (data == "buy_cant_space") {
                    this.socket.removeListener("player", buyCheck1)
                    this.socket.removeListener("game_response", buyCheck2)
                    reject(`Not enough inventory space to buy ${quantity} ${itemName}(s)`)
                } else if (data == "buy_cost") {
                    this.socket.removeListener("player", buyCheck1)
                    this.socket.removeListener("game_response", buyCheck2)
                    reject(`Not enough gold to buy ${quantity} ${itemName}(s)`)
                }
            }
            setTimeout(() => {
                this.socket.removeListener("player", buyCheck1)
                this.socket.removeListener("game_response", buyCheck2)
                reject(`buy timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", buyCheck1)
            this.socket.on("game_response", buyCheck2)
        })

        if (this.G.items[itemName].s) {
            // Item is stackable
            this.socket.emit("buy", { name: itemName, quantity: quantity })
        } else {
            // Item is not stackable.
            this.socket.emit("buy", { name: itemName })
        }
        return itemReceived
    }

    // TODO: Add promises
    public buyFromMerchant(id: string, slot: TradeSlotType, rid: string, quantity = 1): unknown {
        if (quantity <= 0) return Promise.reject(`We can not buy a quantity of ${quantity}.`)
        const merchant = this.players.get(id)
        if (!merchant) return Promise.reject(`We can not see ${id} nearby.`)
        if (Tools.distance(this.character, merchant) > NPC_INTERACTION_DISTANCE) return Promise.reject(`We are too far away from ${id} to buy from.`)

        if (!merchant.slots[slot].q && quantity != 1) {
            console.warn("We are only going to buy 1, as there is only 1 available.")
            quantity = 1
        } else if (merchant.slots[slot].q && quantity > merchant.slots[slot].q) {
            console.warn(`We can't buy ${quantity}, we can only buy ${merchant.slots[slot].q}, so we're doing that.`)
            quantity = merchant.slots[slot].q
        }

        if (this.character.gold < merchant.slots[slot].price * quantity) {
            if (this.character.gold < merchant.slots[slot].price) return Promise.reject(`We don't have enough gold. It costs ${merchant.slots[slot].price}, but we only have ${this.character.gold}`)

            // Determine how many we *can* buy.
            const buyableQuantity = Math.floor(this.character.gold / merchant.slots[slot].price)
            console.warn(`We don't have enough gold to buy ${quantity}, we can only buy ${buyableQuantity}, so we're doing that.`)
            quantity = buyableQuantity
        }

        this.socket.emit("trade_buy", { slot: slot, id: id, rid: rid, q: quantity })
    }

    // TODO: Add promises
    // TODO: Check gold
    public buyFromPonty(item: ItemInfo): unknown {
        if (!item.rid) return Promise.reject("This item does not have an 'rid'.")
        const price = this.G.items[item.name].g * (item.q ? item.q : 1)
        if (price > this.character.gold) return Promise.reject("We don't have enough gold to buy this.")
        this.socket.emit("sbuy", { rid: item.rid })
    }

    public canBuy(item: ItemName): boolean {
        // Check if we're full of items
        if (this.isFull()) return false

        const gInfo = this.G.items[item]
        const buyable = gInfo.buy == true
        if (!buyable) {
            // Double check if we can buy from an NPC
            for (const map in this.G.maps) {
                if (this.G.maps[map as MapName].ignore) continue
                for (const npc of this.G.maps[map as MapName].npcs) {
                    if (this.G.npcs[npc.id].items === undefined) continue
                    for (const i of this.G.npcs[npc.id].items) {
                        if (i == item) return true
                    }
                }
            }

            return false
        }

        // Check if we have enough gold
        const computerAvailable = this.locateItem("computer") !== undefined
        const canAfford = this.character.gold >= gInfo.g
        if (computerAvailable && canAfford) return true

        // TODO: Check if we're near an NPC that sells this item, and if we are, return true

        return false
    }

    public canUse(skill: SkillName): boolean {
        if (this.character.rip) return false // We are dead
        if (this.character.s.stoned) return false // We are 'stoned' (oneeye condition)
        if (this.getCooldown(skill) > 0) return false // Skill is on cooldown
        const gInfoSkill = this.G.skills[skill]
        if (gInfoSkill.mp !== undefined && this.character.mp < gInfoSkill.mp) return false // Not enough MP
        if (skill == "attack" && this.character.mp < this.character.mp_cost) return false // Not enough MP (attack)
        if (gInfoSkill.level !== undefined && this.character.level < gInfoSkill.level) return false // Not a high enough level
        if (gInfoSkill.wtype) {
            // The skill requires a certain weapon type
            if (!this.character.slots.mainhand) return false // We don't have any weapon equipped
            const gInfoWeapon = this.G.items[this.character.slots.mainhand.name]
            if (typeof gInfoSkill.wtype == "object") {
                // There's a list of acceptable weapon types
                let isAcceptableWeapon = false
                for (const wtype of gInfoSkill.wtype) {
                    if (gInfoWeapon.wtype == wtype) {
                        isAcceptableWeapon = true
                        break
                    }
                }
                if (!isAcceptableWeapon) return false
            } else {
                // There's only one acceptable weapon type
                if (gInfoWeapon.wtype !== gInfoSkill.wtype) return false // We don't have the right weapon type equipped
            }
        }
        if (gInfoSkill.slot) {
            // The skill requires a certain item
            for (const [slot, item] of gInfoSkill.slot) {
                if (!this.character.slots[slot]) return false // We don't have anything equipped in one of the slots required
                if (this.character.slots[slot].name !== item) return false // We don't have the right item equipped in the slot
            }
        }
        if (gInfoSkill.class) {
            // The skill is only available to certain classes
            let compatibleClass = false
            for (const c of gInfoSkill.class) {
                if (c == this.character.ctype) {
                    compatibleClass = true // We are compatible!
                    break
                }
            }
            if (!compatibleClass) return false
        }

        // Special circumstances
        if (this.character.s.dampened) {
            if (skill == "blink") return false
        }

        return true
    }

    // TODO: Return better compound info
    // TODO: Add offering
    public compound(item1Pos: number, item2Pos: number, item3Pos: number, cscrollPos: number, offeringPos?: number): Promise<boolean> {
        const item1Info = this.character.items[item1Pos]
        const item2Info = this.character.items[item2Pos]
        const item3Info = this.character.items[item3Pos]
        const cscrollInfo = this.character.items[cscrollPos]
        if (!item1Info) return Promise.reject(`There is no item in inventory slot ${item1Pos} (item1).`)
        if (!item2Info) return Promise.reject(`There is no item in inventory slot ${item2Pos} (item2).`)
        if (!item3Info) return Promise.reject(`There is no item in inventory slot ${item3Pos} (item3).`)
        if (!cscrollInfo) return Promise.reject(`There is no item in inventory slot ${cscrollPos} (cscroll).`)
        if (item1Info.name != item2Info.name || item1Info.name != item3Info.name) return Promise.reject("You can only combine 3 of the same items.")
        if (item1Info.level != item2Info.level || item1Info.level != item3Info.level) return Promise.reject("You can only combine 3 items of the same level.")

        const compoundComplete = new Promise<boolean>((resolve, reject) => {
            const completeCheck = (data: UpgradeData) => {
                if (data.type == "compound") {
                    this.socket.removeListener("upgrade", completeCheck)
                    this.socket.removeListener("game_response", gameResponseCheck)
                    this.socket.removeListener("player", playerCheck)
                    resolve(data.success == 1)
                }
            }

            const playerCheck = (data: CharacterData) => {
                if (!data.hitchhikers) return
                for (const [event, datum] of data.hitchhikers) {
                    if (event == "game_response" && datum.response == "compound_fail") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        resolve(false)
                        return
                    } else if (event == "game_response" && datum.response == "compound_success") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        resolve(true)
                        return
                    }
                }
            }

            const gameResponseCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "bank_restrictions" && data.place == "compound") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        reject("You can't compound items in the bank.")
                    }
                } else if (typeof data == "string") {
                    if (data == "compound_no_item") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        reject()
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("upgrade", completeCheck)
                this.socket.removeListener("game_response", gameResponseCheck)
                this.socket.removeListener("player", playerCheck)
                reject("compound timeout (60000ms)")
            }, 60000)
            this.socket.on("upgrade", completeCheck)
            this.socket.on("game_response", gameResponseCheck)
            this.socket.on("player", playerCheck)
        })

        this.socket.emit("compound", {
            "items": [item1Pos, item2Pos, item3Pos],
            "scroll_num": cscrollPos,
            "clevel": item1Info.level
        })
        return compoundComplete
    }

    // TODO: Add promises
    public depositGold(gold: number): unknown {
        // TODO: Check if you can be in the basement and deposit gold
        if (this.character.map !== "bank") return Promise.reject("We need to be in 'bank' to deposit gold.")
        if (gold <= 0) return Promise.reject("We can't deposit 0 or less gold")

        if (this.character.gold < gold) {
            gold = this.character.gold
            console.warn(`We are only going to deposit ${gold} gold.`)
        }
        this.socket.emit("bank", { operation: "deposit", amount: gold })
    }

    public depositItem(inventoryPos: number, bankPack?: Exclude<BankPackType, "gold">, bankSlot = -1): unknown {
        if (this.character.map !== "bank" && this.character.map !== "bank_b" && this.character.map !== "bank_u") return Promise.reject(`We're not in the bank (we're in '${this.character.map}')`)

        const item = this.character.items[inventoryPos]
        if (!item) return Promise.reject(`There is no item in inventory slot ${inventoryPos}.`)

        if (bankPack) {
            // Check if we can access the supplied bankPack
            const bankPackNum = Number.parseInt(bankPack.substr(5, 2))
            if ((this.character.map == "bank" && bankPackNum < 0 && bankPackNum > 7)
                || (this.character.map == "bank_b" && bankPackNum < 8 && bankPackNum > 23)
                || (this.character.map == "bank_u" && bankPackNum < 24 && bankPackNum > 47)) {
                return Promise.reject(`We can not access ${bankPack} on ${this.character.map}.`)
            }
        } else {
            // Look for a good bankPack
            bankSlot = undefined
            let packFrom: number
            let packTo: number
            if (this.character.map == "bank") {
                packFrom = 0
                packTo = 7
            } else if (this.character.map == "bank_b") {
                packFrom = 8
                packTo = 23
            } else if (this.character.map == "bank_u") {
                packFrom = 24
                packTo = 47
            }

            const numStackable = this.G.items[item.name].s

            let emptyPack: Exclude<BankPackType, "gold">
            let emptySlot: number
            for (let packNum = packFrom; packNum <= packTo; packNum++) {
                const packName = `items${packNum}` as Exclude<BankPackType, "gold">
                const pack = this.bank[packName] as ItemInfo[]
                if (!pack) continue // We don't have access to this pack
                for (let slotNum = 0; slotNum < pack.length; slotNum++) {
                    const slot = pack[slotNum]
                    if (!slot) {
                        if (!numStackable) {
                            // We can't stack the item, and we found a bank slot with nothing in it. Perfect!
                            bankPack = packName
                            bankSlot = slotNum
                            break
                        } else if (!emptyPack && emptySlot == undefined) {
                            // We can stack the item, but we don't want to use up a space right away if we can add these to another stack
                            emptyPack = packName
                            emptySlot = slotNum
                        }
                    } else if (numStackable && slot.name == item.name && (slot.q + item.q <= numStackable)) {
                        // We found a place to stack our items!
                        bankPack = packName
                        bankSlot = -1 // Apparently -1 will figure it out...
                        break
                    }
                }

                if (bankPack && bankSlot !== undefined) break // We found something
            }
            if (bankPack == undefined && bankSlot == undefined && emptyPack !== undefined && emptySlot !== undefined) {
                // We can't stack it on an existing stack, use an empty slot we found
                bankPack = emptyPack
                bankSlot = emptySlot
            } else if (bankPack === undefined && bankSlot === undefined && emptyPack === undefined && emptySlot === undefined) {
                // We have nowhere to stack it...
                return Promise.reject(`Bank is full. There is nowhere to place '${item.name}'.`)
            }
        }

        const bankItemCount = this.countItem(item.name, this.bank[bankPack])
        const swapped = new Promise((resolve, reject) => {
            const checkDeposit = (data: CharacterData) => {
                if (!data.user) {
                    if (data.map !== "bank" && data.map !== "bank_b" && data.map !== "bank_u") {
                        this.socket.removeListener("player", checkDeposit)
                        return reject(`We're not in the bank (we're in '${data.map}')`)
                    }
                } else {
                    const newBankItemCount = this.countItem(item.name, data.user[bankPack])
                    if ((item.q && newBankItemCount == (bankItemCount + item.q))
                        || (!item.q && newBankItemCount == (bankItemCount + 1))) {
                        this.socket.removeListener("player", checkDeposit)
                        return resolve()
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", checkDeposit)
                reject(`depositItem timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", checkDeposit)
        })

        this.socket.emit("bank", { operation: "swap", pack: bankPack, str: bankSlot, inv: inventoryPos })
        return swapped
    }

    public equip(inventoryPos: number, equipSlot?: SlotType): Promise<unknown> {
        if (!this.character.items[inventoryPos]) return Promise.reject(`No item in inventory slot ${inventoryPos}.`)

        const iInfo = this.character.items[inventoryPos]
        // const gInfo = this.game.G.items[iInfo.name]
        // const beforeSlots = this.game.character.slots

        const equipFinished = new Promise((resolve, reject) => {
            const equipCheck = (data: CharacterData) => {
                if (equipSlot) {
                    // Check the slot we equipped it to
                    const item = data.slots[equipSlot]
                    if (item
                        && item.name == iInfo.name
                        && item.level == iInfo.level
                        && item.p == iInfo.p) {
                        this.socket.removeListener("player", equipCheck)
                        this.socket.removeListener("disappearing_text", cantEquipCheck)
                        resolve()
                    }
                } else {
                    // Look for the item in all of the slots
                    for (const slot in data.slots) {
                        const item = data.slots[slot as SlotType]
                        if (item && item.name == iInfo.name) {
                            this.socket.removeListener("player", equipCheck)
                            this.socket.removeListener("disappearing_text", cantEquipCheck)
                            resolve()
                        }
                    }
                }
            }
            const cantEquipCheck = (data: DisappearingTextData) => {
                if (data.id == this.character.id && data.message == "CAN'T EQUIP") {
                    this.socket.removeListener("player", equipCheck)
                    this.socket.removeListener("disappearing_text", cantEquipCheck)
                    reject(`Can't equip '${inventoryPos}' (${iInfo.name})`)
                }
            }
            setTimeout(() => {
                this.socket.removeListener("player", equipCheck)
                this.socket.removeListener("disappearing_text", cantEquipCheck)
                reject(`equip timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", equipCheck)
            this.socket.on("disappearing_text", cantEquipCheck)
        })

        this.socket.emit("equip", { num: inventoryPos, slot: equipSlot })
        return equipFinished
    }

    public exchange(inventoryPos: number): Promise<unknown> {
        if (!this.character.items[inventoryPos]) return Promise.reject(`No item in inventory slot ${inventoryPos}.`)

        const exchangeFinished = new Promise((resolve, reject) => {
            const completeCheck = (data: UpgradeData) => {
                if (data.type == "exchange") {
                    this.socket.removeListener("upgrade", completeCheck)
                    this.socket.removeListener("game_response", bankCheck)
                    resolve(data.success == 1)
                }
            }
            const bankCheck = (data: GameResponseData) => {
                if (typeof data == "object" && data.response == "bank_restrictions" && data.place == "upgrade") {
                    this.socket.removeListener("upgrade", completeCheck)
                    this.socket.removeListener("game_response", bankCheck)
                    reject("You can't exchange items in the bank.")
                } else if (typeof data == "string") {
                    if (data == "exchange_notenough") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", bankCheck)
                        reject("We don't have enough items to exchange.")
                    } else if (data == "exchange_existing") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", bankCheck)
                        reject("We are already exchanging something.")
                    }
                }
            }
            setTimeout(() => {
                this.socket.removeListener("upgrade", completeCheck)
                this.socket.removeListener("game_response", bankCheck)
                reject(`exchange timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("game_response", bankCheck)
            this.socket.on("upgrade", completeCheck)
        })

        this.socket.emit("exchange", { item_num: inventoryPos, q: this.character.items[inventoryPos]?.q })
        return exchangeFinished
    }

    // TODO: Add promises and checks
    public finishMonsterHuntQuest() {
        this.socket.emit("monsterhunt")
    }

    public getMonsterHuntQuest(): Promise<unknown> {
        if (this.character.ctype == "merchant") return Promise.reject("Merchants can't do Monster Hunts.")
        let close = false
        // Look for a monsterhunter on the current map
        for (const npc of this.G.maps[this.character.map].npcs) {
            if (npc.id !== "monsterhunter") continue
            if (Tools.distance(this.character, { x: npc.position[0], y: npc.position[1] }) <= NPC_INTERACTION_DISTANCE) {
                close = true
                break
            }
        }
        if (!close) return Promise.reject("We are too far away from the Monster Hunter NPC.")
        if (this.character.s.monsterhunt && this.character.s.monsterhunt.c > 0) return Promise.reject(`We can't get a new monsterhunt. We have ${this.character.s.monsterhunt.ms}ms left to kill ${this.character.s.monsterhunt.c} ${this.character.s.monsterhunt.id}s.`)

        if (this.character.s.monsterhunt && this.character.s.monsterhunt.c == 0) {
            console.warn("We are going to complete the current monster quest first")
            this.finishMonsterHuntQuest()
        }

        const questGot = new Promise((resolve, reject) => {
            const failCheck = (data: GameResponseData) => {
                if (data == "ecu_get_closer") {
                    this.socket.removeListener("game_response", failCheck)
                    this.socket.removeListener("player", successCheck)
                    reject("Too far away from Monster Hunt NPC.")
                } else if (data == "monsterhunt_merchant") {
                    this.socket.removeListener("game_response", failCheck)
                    this.socket.removeListener("player", successCheck)
                    reject("Merchants can't do Monster Hunts.")
                }
            }
            const successCheck = (data: CharacterData) => {
                if (!data.hitchhikers) return
                for (const hitchhiker of data.hitchhikers) {
                    if (hitchhiker[0] == "game_response" && hitchhiker[1] == "monsterhunt_started") {
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("player", successCheck)
                        resolve()
                        return
                    }
                }
            }
            setTimeout(() => {
                this.socket.removeListener("game_response", failCheck)
                this.socket.removeListener("player", successCheck)
                reject(`getMonsterHuntQuest timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("game_response", failCheck)
            this.socket.on("player", successCheck)
        })

        this.socket.emit("monsterhunt")
        return questGot
    }

    public getPontyItems(): Promise<ItemInfo[]> {
        const pontyItems = new Promise<ItemInfo[]>((resolve, reject) => {
            const distanceCheck = (data: GameResponseData) => {
                if (data == "buy_get_closer") {
                    this.socket.removeListener("game_response", distanceCheck)
                    this.socket.removeListener("secondhands", secondhandsItems)
                    reject("Too far away from secondhands NPC.")
                }
            }

            const secondhandsItems = (data: ItemInfo[]) => {
                this.socket.removeListener("game_response", distanceCheck)
                this.socket.removeListener("secondhands", secondhandsItems)
                resolve(data)
            }

            setTimeout(() => {
                this.socket.removeListener("game_response", distanceCheck)
                this.socket.removeListener("secondhands", secondhandsItems)
                reject(`getPontyItems timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("secondhands", secondhandsItems)
            this.socket.on("game_response", distanceCheck)
        })

        this.socket.emit("secondhands")
        return pontyItems
    }

    /**
     * Returns true if our inventory is full, false otherwise
     */
    public isFull(): boolean {
        for (let i = this.character.items.length - 1; i >= 0; i--) {
            const item = this.character.items[i]
            if (!item) return false
        }
        return true
    }

    /**
     * For use on 'cyberland' and 'jail' to leave the map. You will be transported to the spawn on "main".
     */
    public leaveMap(): Promise<unknown> {
        const leaveComplete = new Promise((resolve, reject) => {
            this.socket.once("new_map", (data: NewMapData) => {
                if (data.name == "main") resolve()
                else reject(`We are now in ${data.name}, but we should be in main`)
            })

            setTimeout(() => {
                reject(`leaveMap timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
        })

        this.socket.emit("leave")
        return leaveComplete
    }

    // TODO: Add checks and promises
    public leaveParty() {
        this.socket.emit("party", { event: "leave" })
    }

    public async move(x: number, y: number, safetyCheck = true): Promise<NodeData> {
        // Check if we're already there
        if (this.character.x == x && this.character.y == y) return Promise.resolve({ map: this.character.map, y: this.character.y, x: this.character.x })

        let to: IPosition = { map: this.character.map, x: x, y: y }
        if (safetyCheck) {
            to = Pathfinder.getSafeWalkTo(
                { map: this.character.map, x: this.character.x, y: this.character.y },
                { map: this.character.map, x, y })
            if (to.x !== x || to.y !== y) {
                console.warn(`move: We can't move to {x: ${x}, y: ${y}} safely. We will move to {x: ${to.x}, y: ${to.y}}.`)
            }
        }
        const moveFinished = new Promise<NodeData>((resolve, reject) => {
            let timeToFinishMove = 1 + Tools.distance(this.character, { x: to.x, y: to.y }) / this.character.speed

            const checkPlayer = async (data: CharacterData) => {
                if (!data.moving || data.going_x != to.x || data.going_y != to.y) {
                    // We *might* not be moving in the right direction. Let's request new data and check.
                    const newData = await this.requestPlayerData()
                    if (!newData.moving || newData.going_x != to.x || newData.going_y != to.y) {
                        clearTimeout(timeout)
                        this.socket.removeListener("player", checkPlayer)
                        reject(`move to ${to.x}, ${to.y} failed`)
                    }
                } else {
                    // We're still moving in the right direction
                    timeToFinishMove = Tools.distance(this.character, { x: data.x, y: data.y }) / data.speed
                    clearTimeout(timeout)
                    timeout = setTimeout(checkPosition, timeToFinishMove)
                }
            }

            const checkPosition = () => {
                // Force an update of the character position
                this.updatePositions()
                timeToFinishMove = 1 + Tools.distance(this.character, { x: to.x, y: to.y }) / this.character.speed

                if (this.character.x == to.x && this.character.y == to.y) {
                    // We are here!
                    this.socket.removeListener("player", checkPlayer)
                    resolve(this.character)
                } else if (this.character.moving && this.character.going_x == to.x && this.character.going_y == to.y) {
                    // We are still moving in the right direction
                    timeout = setTimeout(checkPosition, timeToFinishMove)
                } else {
                    // We're not moving in the right direction
                    this.socket.removeListener("player", checkPlayer)
                    reject(`move to ${to.x}, ${to.y} failed (we're currently going to ${this.character.going_x}, ${this.character.going_y})`)
                }
            }
            let timeout = setTimeout(checkPosition, timeToFinishMove)

            this.socket.on("player", checkPlayer)
        })

        this.socket.emit("move", {
            x: this.character.x,
            y: this.character.y,
            going_x: to.x,
            going_y: to.y,
            m: this.character.m
        })
        this.updatePositions()
        this.character.going_x = to.x
        this.character.going_y = to.y
        this.character.moving = true
        return moveFinished
    }

    // TODO: Add promises and checks
    public openChest(id: string) {
        this.socket.emit("open_chest", { id: id })
    }

    public regenHP(): Promise<unknown> {
        const regenReceived = new Promise((resolve, reject) => {
            const regenCheck = (data: EvalData) => {
                if (data.code.includes("pot_timeout")) {
                    this.socket.removeListener("eval", regenCheck)
                    resolve()
                }
            }
            setTimeout(() => {
                this.socket.removeListener("eval", regenCheck)
                reject(`regenHP timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", regenCheck)
        })

        this.socket.emit("use", { item: "hp" })
        return regenReceived
    }

    public regenMP(): Promise<unknown> {
        // if (this.game.nextSkill.get("use_mp")?.getTime() > Date.now()) return Promise.reject("use_mp is on cooldown")

        const regenReceived = new Promise((resolve, reject) => {
            const regenCheck = (data: EvalData) => {
                if (data.code.includes("pot_timeout")) {
                    this.socket.removeListener("eval", regenCheck)
                    resolve()
                }
            }
            setTimeout(() => {
                this.socket.removeListener("eval", regenCheck)
                reject(`regenMP timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", regenCheck)
        })

        this.socket.emit("use", { item: "mp" })
        return regenReceived
    }

    // TODO: Improve with promises
    public respawn(): void {
        this.socket.emit("respawn")
    }

    public scare(): Promise<string[]> {
        const scared = new Promise<string[]>((resolve, reject) => {
            // TODO: Move this typescript to a definition
            let ids: string[]
            const idsCheck = (data: UIData) => {
                if (data.type == "scare") {
                    ids = data.ids
                    this.socket.removeListener("ui", idsCheck)
                }
            }

            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]scare['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("ui", idsCheck)
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve(ids)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("ui", idsCheck)
                this.socket.removeListener("eval", cooldownCheck)
                reject(`scare timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("ui", idsCheck)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "scare" })
        return scared
    }

    // TODO: Add promises
    public async sell(itemPos: number, quantity = 1): Promise<void> {
        this.socket.emit("sell", { num: itemPos, quantity: quantity })
    }

    public async sendGold(to: string, amount: number): Promise<number> {
        if (this.character.gold == 0) return Promise.reject("We have no gold to send.")
        if (!this.players.has(to)) return Promise.reject(`We can not see ${to} to send gold.`)

        const goldSent: Promise<number> = new Promise((resolve, reject) => {
            const sentCheck = (data: GameResponseData) => {
                if (data == "trade_get_closer") {
                    this.socket.removeListener("game_response", sentCheck)
                    reject(`We are too far away from ${to} to send gold.`)
                } else if (typeof data == "object" && data.response == "gold_sent" && data.name == to) {
                    if (data.gold !== amount) console.warn(`We wanted to send ${to} ${amount} gold, but we sent ${data.gold}.`)
                    this.socket.removeListener("game_response", sentCheck)
                    resolve(data.gold)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("game_response", sentCheck)
                reject(`sendGold timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("game_response", sentCheck)
        })
        this.socket.emit("send", { name: to, gold: amount })
        return goldSent
    }

    public sendItem(to: string, inventoryPos: number, quantity = 1): Promise<unknown> {
        if (!this.players.has(to)) return Promise.reject(`"${to}" is not nearby.`)
        if (!this.character.items[inventoryPos]) return Promise.reject(`No item in inventory slot ${inventoryPos}.`)
        if (this.character.items[inventoryPos]?.q < quantity) return Promise.reject(`We only have a quantity of ${this.character.items[inventoryPos].q}, not ${quantity}.`)

        const item = this.character.items[inventoryPos]

        const itemSent = new Promise((resolve, reject) => {
            const sentCheck = (data: GameResponseData) => {
                if (data == "trade_get_closer") {
                    this.socket.removeListener("game_response", sentCheck)
                    reject(`sendItem failed, ${to} is too far away`)
                } else if (data == "send_no_space") {
                    this.socket.removeListener("game_response", sentCheck)
                    reject(`sendItem failed, ${to} has no inventory space`)
                } else if (typeof data == "object" && data.response == "item_sent" && data.name == to && data.item == item.name && data.q == quantity) {
                    this.socket.removeListener("game_response", sentCheck)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("game_response", sentCheck)
                reject(`sendItem timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("game_response", sentCheck)
        })

        this.socket.emit("send", { name: to, num: inventoryPos, q: quantity })
        return itemSent
    }

    /**
     * Invites the given character to our party.
     * @param id The character ID to invite to our party.
     */
    // TODO: See what socket events happen, and see if we can see if the server picked up our request
    public sendPartyInvite(id: string) {
        this.socket.emit("party", { event: "invite", name: id })
    }

    /**
     * Requests to join another character's party.
     * @param id The character ID to request a party invite from.
     */
    // TODO: See what socket events happen, and see if we can see if the server picked up our request
    public sendPartyRequest(id: string) {
        this.socket.emit("party", { event: "request", name: id })
    }

    protected lastSmartMove: number = Date.now()
    /**
     * A function that moves to, and returns when we move to a given location
     * @param to Where to move to. If given a string, we will try to navigate to the proper location.
     */
    public async smartMove(to: MapName | MonsterName | NPCType | IPosition, options: { getWithin?: number, useBlink?: boolean } = {
        getWithin: 0,
        useBlink: false
    }): Promise<NodeData> {
        const started = Date.now()
        this.lastSmartMove = started
        let fixedTo: NodeData
        let path: LinkData[]
        if (typeof to == "string") {
            // Check if our destination is a map name
            for (const mapName in this.G.maps) {
                if (to !== mapName) continue

                // Set `to` to the `town` spawn on the map
                const mainSpawn = this.G.maps[to as MapName].spawns[0]
                fixedTo = { map: to as MapName, x: mainSpawn[0], y: mainSpawn[1] }
                break
            }

            // Check if our destination is a monster type
            if (!fixedTo) {
                for (const mtype in this.G.monsters) {
                    if (to !== mtype) continue

                    // Set `to` to the closest spawn for these monsters
                    const locations = this.locateMonsters(mtype as MonsterName)
                    let closestDistance: number = Number.MAX_VALUE
                    for (const location of locations) {
                        const potentialPath = await Pathfinder.getPath(this.character, location)
                        const distance = Pathfinder.computePathCost(potentialPath)
                        if (distance < closestDistance) {
                            path = potentialPath
                            fixedTo = path[path.length - 1]
                            closestDistance = distance
                        }
                    }
                    break
                }
            }

            // Check if our destination is an NPC role
            if (!fixedTo) {
                for (const mapName in this.G.maps) {
                    if (this.G.maps[mapName as MapName].ignore) continue
                    for (const npc of this.G.maps[mapName as MapName].npcs) {
                        if (to !== npc.id) continue

                        // Set `to` to the closest NPC
                        const locations = this.locateNPCs(npc.id)
                        let closestDistance: number = Number.MAX_VALUE
                        for (const location of locations) {
                            const potentialPath = await Pathfinder.getPath(this.character, location)
                            const distance = Pathfinder.computePathCost(potentialPath)
                            if (distance < closestDistance) {
                                path = potentialPath
                                fixedTo = path[path.length - 1]
                                closestDistance = distance
                            }
                        }
                        break
                    }
                }
            }

            if (!fixedTo) return Promise.reject(`Could not find a suitable destination for '${to}'`)
        } else if (to.x !== undefined && to.y !== undefined) {
            if (to.map) fixedTo = to as NodeData
            else fixedTo = { map: this.character.map, x: to.x, y: to.y }
        } else {
            console.log(to)
            return Promise.reject("'to' is unsuitable for smartMove. We need a 'map', an 'x', and a 'y'.")
        }

        // Check if we're already close enough
        if (options && options.getWithin !== undefined && Tools.distance(this.character, fixedTo) <= options.getWithin) return Promise.resolve(this.character)

        // If we don't have the path yet, get it
        if (!path) path = await Pathfinder.getPath(this.character, fixedTo)

        let lastMove = -1
        for (let i = 0; i < path.length; i++) {
            let currentMove = path[i]

            if (started < this.lastSmartMove) {
                if (typeof to == "string") return Promise.reject(`smartMove to ${to} cancelled (new smartMove started)`)
                else return Promise.reject(`smartMove to ${to.map}:${to.x},${to.y} cancelled (new smartMove started)`)
            }

            // Check if we can walk to a spot close to the goal if that's OK
            if (currentMove.type == "move" && this.character.map == fixedTo.map && options.getWithin > 0) {
                // Calculate distance to
                const distance = Tools.distance(currentMove, fixedTo)

                if (distance < options.getWithin) {
                    break // We're already close enough!
                }

                const angle = Math.atan2(this.character.y - fixedTo.y, this.character.x - fixedTo.x)
                const potentialMove: LinkData = {
                    type: "move",
                    map: this.character.map,
                    x: fixedTo.x + Math.cos(angle) * options.getWithin,
                    y: fixedTo.y + Math.sin(angle) * options.getWithin
                }
                if (Pathfinder.canWalk(this.character, potentialMove)) {
                    i = path.length
                    currentMove = potentialMove
                }
            }

            // Skip check -- check if we can move to the next node
            if (currentMove.type == "move") {
                for (let j = i + 1; j < path.length; j++) {
                    const potentialMove = path[j]
                    if (potentialMove.map !== currentMove.map) break

                    if (potentialMove.type == "move" && Pathfinder.canWalk(this.character, potentialMove)) {
                        i = j
                        currentMove = potentialMove
                    }
                }
            }

            // Blink skip check
            if (options.useBlink && this.canUse("blink")) {
                let blinked = false
                for (let j = path.length - 1; j > i; j--) {
                    const potentialMove = path[j]
                    if (potentialMove.map == currentMove.map) {
                        await (this as unknown as Mage).blink(potentialMove.x, potentialMove.y)
                        i = j
                        blinked = true
                        break
                    }
                }
                if (blinked) continue
            }

            // Perform the next movement
            try {
                if (currentMove.type == "leave") {
                    await this.leaveMap()
                } else if (currentMove.type == "move") {
                    if (currentMove.map !== this.character.map) {
                        return Promise.reject(`We are supposed to be in ${currentMove.map}, but we are in ${this.character.map}`)
                    }
                    await this.move(currentMove.x, currentMove.y, false)
                } else if (currentMove.type == "town") {
                    await this.warpToTown()
                } else if (currentMove.type == "transport") {
                    await this.transport(currentMove.map, currentMove.spawn)
                }
            } catch (e) {
                console.error(e)
                await this.requestPlayerData()
                if (lastMove == i) return Promise.reject("We are having some trouble smartMoving...")
                lastMove = i
                i--
            }
        }

        return { map: this.character.map, x: this.character.x, y: this.character.y }
    }

    public async stopSmartMove(): Promise<NodeData> {
        this.lastSmartMove = Date.now()
        return this.move(this.character.x, this.character.y)
    }

    // TODO: Add promises
    public stopWarpToTown(): void {
        this.socket.emit("stop", { action: "town" })
    }

    public transport(map: MapName, spawn: number): Promise<unknown> {
        const transportComplete = new Promise((resolve, reject) => {
            this.socket.once("new_map", (data: NewMapData) => {
                if (data.name == map) resolve()
                else reject(`We are now in ${data.name}, but we should be in ${map}`)
            })

            setTimeout(() => {
                reject(`transport timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
        })

        this.socket.emit("transport", { to: map, s: spawn })
        return transportComplete
    }

    public unequip(slot: SlotType | TradeSlotType): Promise<unknown> {
        if (this.character.slots[slot] === null) return Promise.reject(`Slot ${slot} is empty; nothing to unequip.`)
        if (this.character.slots[slot] === undefined) return Promise.reject(`Slot ${slot} does not exist.`)

        const unequipped = new Promise((resolve, reject) => {
            const unequipCheck = (data: CharacterData) => {
                if (data.slots[slot] === null) {
                    this.socket.removeListener("player", unequipCheck)
                    resolve()
                }
            }
            setTimeout(() => {
                this.socket.removeListener("player", unequipCheck)
                reject(`unequip timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
        })

        this.socket.emit("unequip", { slot: slot })
        return unequipped
    }

    // TODO: Add offering support
    public upgrade(itemPos: number, scrollPos: number): Promise<boolean> {
        if (this.character.map.startsWith("bank")) return Promise.reject("We can't upgrade things in the bank.")

        const itemInfo = this.character.items[itemPos]
        const scrollInfo = this.character.items[scrollPos]
        if (!itemInfo) return Promise.reject(`There is no item in inventory slot ${itemPos}.`)
        if (this.G.items[itemInfo.name].upgrade == undefined) return Promise.reject("This item is not upgradable.")
        if (!scrollInfo) return Promise.reject(`There is no scroll in inventory slot ${scrollPos}.`)

        const upgradeComplete = new Promise<boolean>((resolve, reject) => {
            const completeCheck = (data: UpgradeData) => {
                if (data.type == "upgrade") {
                    this.socket.removeListener("upgrade", completeCheck)
                    this.socket.removeListener("game_response", gameResponseCheck)
                    this.socket.removeListener("player", playerCheck)
                    resolve(data.success == 1)
                }
            }

            const playerCheck = (data: CharacterData) => {
                if (!data.hitchhikers) return
                for (const [event, datum] of data.hitchhikers) {
                    if (event == "game_response" && datum.response == "upgrade_fail" && datum.num == itemPos) {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        resolve(false)
                        return
                    } else if (event == "game_response" && datum.response == "upgrade_success" && datum.num == itemPos) {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        resolve(true)
                        return
                    }
                }
            }

            const gameResponseCheck = (data: GameResponseData) => {
                if (typeof data == "object" && data.response == "bank_restrictions" && data.place == "upgrade") {
                    this.socket.removeListener("upgrade", completeCheck)
                    this.socket.removeListener("game_response", gameResponseCheck)
                    this.socket.removeListener("player", playerCheck)
                    reject("You can't upgrade items in the bank.")
                } else if (typeof data == "string") {
                    if (data == "bank_restrictions") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        reject("We can't upgrade things in the bank.")
                    } else if (data == "upgrade_in_progress") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        reject("We are already upgrading something.")
                    } else if (data == "upgrade_incompatible_scroll") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        reject(`The scroll we're trying to use (${scrollInfo.name}) isn't a high enough grade to upgrade this item.`)
                    } else if (data == "upgrade_success") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        resolve(true)
                    } else if (data == "upgrade_fail") {
                        this.socket.removeListener("upgrade", completeCheck)
                        this.socket.removeListener("game_response", gameResponseCheck)
                        this.socket.removeListener("player", playerCheck)
                        resolve(false)
                    }
                }
            }
            setTimeout(() => {
                this.socket.removeListener("upgrade", completeCheck)
                this.socket.removeListener("game_response", gameResponseCheck)
                this.socket.removeListener("player", playerCheck)
                reject("upgrade timeout (60000ms)")
            }, 60000)
            this.socket.on("upgrade", completeCheck)
            this.socket.on("game_response", gameResponseCheck)
            this.socket.on("player", playerCheck)
        })

        this.socket.emit("upgrade", { item_num: itemPos, scroll_num: scrollPos, clevel: this.character.items[itemPos].level })
        return upgradeComplete
    }

    // TODO: Check if it's an HP Pot
    public useHPPot(itemPos: number): Promise<unknown> {
        if (!this.character.items[itemPos]) return Promise.reject(`There is no item in inventory slot ${itemPos}.`)

        const healReceived = new Promise((resolve, reject) => {
            const healCheck = (data: EvalData) => {
                if (data.code.includes("pot_timeout")) {
                    this.socket.removeListener("eval", healCheck)
                    resolve()
                }
            }
            setTimeout(() => {
                this.socket.removeListener("eval", healCheck)
                reject(`useHPPot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", healCheck)
        })

        this.socket.emit("equip", { num: itemPos })
        return healReceived
    }

    // TODO: Check if it's an MP Pot
    public useMPPot(itemPos: number): Promise<unknown> {
        if (!this.character.items[itemPos]) return Promise.reject(`There is no item in inventory slot ${itemPos}.`)

        const healReceived = new Promise((resolve, reject) => {
            const healCheck = (data: EvalData) => {
                if (data.code.includes("pot_timeout")) {
                    this.socket.removeListener("eval", healCheck)
                    resolve()
                }
            }
            setTimeout(() => {
                this.socket.removeListener("eval", healCheck)
                reject(`useMPPot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", healCheck)
        })

        this.socket.emit("equip", { num: itemPos })
        return healReceived
    }

    public warpToTown(): Promise<NodeData> {
        let startedWarp = false
        const warpComplete = new Promise<NodeData>((resolve, reject) => {
            const failCheck = (data: CharacterData) => {
                if (!startedWarp && data.c.town && data.c.town.ms == 3000) {
                    startedWarp = true
                    return
                }
                if (startedWarp && !data.c.town) {
                    this.socket.removeListener("player", failCheck)
                    this.socket.removeListener("new_map", warpedCheck2)
                    reject("warpToTown failed.")
                }
            }
            const warpedCheck2 = (data: NewMapData) => {
                if (data.effect == 1) {
                    this.socket.removeListener("player", failCheck)
                    this.socket.removeListener("new_map", warpedCheck2)
                    resolve({ map: data.name, x: data.x, y: data.y })
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", failCheck)
                this.socket.removeListener("new_map", warpedCheck2)
                reject("warpToTown timeout (5000ms)")
            }, 5000)
            this.socket.on("new_map", warpedCheck2)
            this.socket.on("player", failCheck)
        })

        this.socket.emit("town")
        return warpComplete
    }

    public withdrawGold(gold: number): unknown {
        // TODO: Check if you can be in the basement and withdraw gold
        if (this.character.map !== "bank") return Promise.reject("We need to be in 'bank' to withdraw gold.")
        if (gold <= 0) return Promise.reject("We can't withdraw 0 or less gold.")

        if (this.bank.gold > gold) {
            gold = this.bank.gold
            console.warn(`We are only going to withdraw ${gold} gold.`)
        }

        this.socket.emit("bank", { operation: "withdraw", amount: gold })
    }

    public withdrawItem(bankPack: Exclude<BankPackType, "gold">, bankPos: number, inventoryPos = -1): unknown {
        const item = this.bank[bankPack][bankPos]
        if (!item) return Promise.reject(`There is no item in bank ${bankPack}[${bankPos}]`)

        const bankPackNum = Number.parseInt(bankPack.substr(5, 2))
        if ((this.character.map == "bank" && bankPackNum < 0 && bankPackNum > 7)
            || (this.character.map == "bank_b" && bankPackNum < 8 && bankPackNum > 23)
            || (this.character.map == "bank_u" && bankPackNum < 24 && bankPackNum > 47)) {
            return Promise.reject(`We can not access ${bankPack} on ${this.character.map}.`)
        }

        const itemCount = this.countItem(item.name)

        const swapped = new Promise((resolve, reject) => {
            // TODO: Resolve
            const checkWithdrawal = (data: CharacterData) => {
                const newCount = this.countItem(item.name, data.items)
                if (item.q && newCount == (itemCount + item.q)
                    || !item.q && newCount == (itemCount + 1)) {
                    this.socket.removeListener("player", checkWithdrawal)
                    return resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", checkWithdrawal)
                reject(`withdrawItem timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", checkWithdrawal)
        })

        console.log({ operation: "swap", pack: bankPack, str: bankPos, inv: inventoryPos })
        this.socket.emit("bank", { operation: "swap", pack: bankPack, str: bankPos, inv: inventoryPos })
        return swapped
    }

    /**
     * Returns the number of items that match the given parameters
     * @param itemName The item to look for
     * @param inventory Where to look for the item
     * @param filters Filters to help search for specific properties on items
     */
    public countItem(item: ItemName, inventory = this.character.items,
        args?: {
            levelGreaterThan?: number,
            levelLessThan?: number
        }): number {
        let count = 0
        for (const inventoryItem of inventory) {
            if (!inventoryItem) continue
            if (inventoryItem.name !== item) continue

            if (args) {
                if (args.levelGreaterThan !== undefined) {
                    if (inventoryItem.level == undefined) continue // This item doesn't have a level
                    if (inventoryItem.level <= args.levelGreaterThan) continue // This item is a lower level than desired
                }
                if (args.levelLessThan !== undefined) {
                    if (inventoryItem.level == undefined) continue // This item doesn't have a level
                    if (inventoryItem.level >= args.levelLessThan) continue // This item is a higher level than desired
                }
            }

            // We have the item!
            if (inventoryItem.q) {
                count += inventoryItem.q
            } else {
                count += 1
            }
        }

        return count
    }

    public getCooldown(skill: SkillName): number {
        // Check if this skill is shared with another cooldown
        if (this.G.skills[skill].share) skill = this.G.skills[skill].share

        const nextSkill = this.nextSkill.get(skill)
        if (!nextSkill) return 0

        const cooldown = nextSkill.getTime() - Date.now()
        if (cooldown < 0) return 0
        return cooldown
    }

    public getNearestMonster(mtype?: MonsterName): { monster: EntityData, distance: number } {
        let closest: EntityData
        let closestD = Number.MAX_VALUE
        this.entities.forEach((entity) => {
            if (mtype && entity.type != mtype) return
            const d = Tools.distance(this.character, entity)
            if (d < closestD) {
                closest = entity
                closestD = d
            }
        })
        if (closest) return { monster: closest, distance: closestD }
    }

    public getNearestAttackablePlayer(): { player: PlayerData, distance: number } {
        if (!this.isPVP()) return undefined

        let closest: PlayerData
        let closestD = Number.MAX_VALUE
        this.players.forEach((player) => {
            if (player.s?.invincible) return
            if (player.npc) return
            const d = Tools.distance(this.character, player)
            if (d < closestD) {
                closest = player
                closestD = d
            }
        })
        if (closest) return { player: closest, distance: closestD }
    }

    /**
     * Returns a boolean corresponding to whether or not the item is in our inventory.
     * @param iN The item to look for
     * @param inv Where to look for the item
     */
    public hasItem(iN: ItemName, inv = this.character.items,
        args?: {
            levelGreaterThan?: number,
            levelLessThan?: number
        }): boolean {
        for (let i = 0; i < inv.length; i++) {
            const item = inv[i]
            if (!item) continue

            if (args) {
                if (args.levelGreaterThan !== undefined) {
                    if (item.level == undefined) continue // This item doesn't have a level
                    if (item.level <= args.levelGreaterThan) continue // This item is a lower level than desired
                }
                if (args.levelLessThan !== undefined) {
                    if (item.level == undefined) continue // This item doesn't have a level
                    if (item.level >= args.levelLessThan) continue // This item is a higher level than desired
                }
            }

            if (item.name == iN) return true
        }
        return false
    }

    /**
     * Returns a boolean corresponding to whether or not we have a given item equipped.
     * @param itemName The item to look for
     */
    public isEquipped(itemName: ItemName): boolean {
        for (const slot in this.character.slots) {
            if (!this.character.slots[slot as SlotType]) continue // Nothing equipped in this slot
            if (this.character.slots[slot as SlotType].name == itemName) return true
        }
        return false
    }

    /**
     * Returns a boolean corresponding to whether or not we can attack other players
     */
    public isPVP(): boolean {
        if (this.G[this.character.map].pvp) return true
        return this.server.pvp
    }

    public locateDuplicateItems(inventory = this.character.items): { [T in ItemName]?: number[] } {
        const items: (ItemInfo & { slotNum: number })[] = []
        for (let i = 0; i < inventory.length; i++) {
            const item = inventory[i]
            if (!item) continue
            items.push({ ...item, slotNum: i })
        }

        // Sort the data to make it easier to parse the data later
        items.sort((a, b) => {
            // Sort alphabetically
            const n = a.name.localeCompare(b.name)
            if (n !== 0) return n

            // Sort lowest level first
            if (a.level !== undefined && b.level !== undefined && a.level !== b.level) return a.level - b.level
        })

        const duplicates: { [T in ItemName]?: number[] } = {}
        for (let i = 0; i < items.length - 1; i++) {
            const item1 = items[i]
            for (let j = i + 1; j < items.length; j++) {
                const item2 = items[j]

                if (item1.name === item2.name) {
                    if (j == i + 1) {
                        duplicates[item1.name] = [item1.slotNum, item2.slotNum]
                    } else {
                        duplicates[item1.name].push(item2.slotNum)
                    }
                } else {
                    i = j - 1
                    break
                }
            }
        }

        return duplicates
    }

    /**
     * Returns the index of the item in the given inventory
     * @param iN The item to look for
     * @param inv Where to look for the item
     * @param args Filters to help search for specific properties on items
     */
    public locateItem(iN: ItemName, inv = this.character.items,
        args?: {
            levelGreaterThan?: number,
            levelLessThan?: number,
            locateHighestLevel?: number
        }): number {
        for (let i = 0; i < inv.length; i++) {
            const item = inv[i]
            if (!item) continue

            if (args) {
                if (args.levelGreaterThan) {
                    if (item.level == undefined) continue // This item doesn't have a level
                    if (item.level <= args.levelGreaterThan) continue // This item is a lower level than desired
                }
                if (args.levelLessThan) {
                    if (item.level == undefined) continue // This item doesn't have a level
                    if (item.level >= args.levelLessThan) continue // This item is a higher level than desired
                }
            }

            if (item.name == iN) {
                return i
            }
        }
        return undefined
    }

    /**
     * Returns a list of indexes of the items in the given inventory
     * @param itemName The item to look for
     * @param inventory Where to look for the item
     * @param filters Filters to help search for specific properties on items
     */
    public locateItems(itemName: ItemName, inventory = this.character.items,
        filters?: {
            levelGreaterThan?: number,
            levelLessThan?: number
        }): number[] {
        const found: number[] = []
        for (let i = 0; i < inventory.length; i++) {
            const item = inventory[i]
            if (!item) continue

            if (filters) {
                if (filters.levelGreaterThan) {
                    if (item.level == undefined) continue // This item doesn't have a level
                    if (item.level <= filters.levelGreaterThan) continue // This item is a lower level than desired
                }
                if (filters.levelLessThan) {
                    if (item.level == undefined) continue // This item doesn't have a level
                    if (item.level >= filters.levelLessThan) continue // This item is a higher level than desired
                }
            }

            if (item.name == itemName) {
                found.push(i)
            }
        }
        return found
    }

    public locateMonsters(mType: MonsterName): NodeData[] {
        const locations: NodeData[] = []

        // Known special monster spawns
        if (mType == "goldenbat") mType = "bat"
        else if (mType == "snowman") mType = "arcticbee"

        for (const mapName in this.G.maps) {
            if (this.G.maps[mapName as MapName].ignore) continue

            const map = this.G.maps[mapName as MapName]
            if (map.instance || !map.monsters || map.monsters.length == 0) continue // Map is unreachable, or there are no monsters

            for (const monsterSpawn of map.monsters) {
                if (monsterSpawn.type != mType) continue
                if (monsterSpawn.boundary) {
                    locations.push({ "map": mapName as MapName, "x": (monsterSpawn.boundary[0] + monsterSpawn.boundary[2]) / 2, "y": (monsterSpawn.boundary[1] + monsterSpawn.boundary[3]) / 2 })
                } else if (monsterSpawn.boundaries) {
                    for (const boundary of monsterSpawn.boundaries) {
                        locations.push({ "map": boundary[0], "x": (boundary[1] + boundary[3]) / 2, "y": (boundary[2] + boundary[4]) / 2 })
                    }
                }
            }
        }

        return locations
    }

    public locateNPCs(npcType: NPCType): NodeData[] {
        const locations: NodeData[] = []
        for (const mapName in this.G.maps) {
            const map = this.G.maps[mapName as MapName]
            if (map.ignore) continue
            if (map.instance || !map.npcs || map.npcs.length == 0) continue // Map is unreachable, or there are no NPCs

            for (const npc of map.npcs) {
                if (npc.id !== npcType) continue

                // TODO: If it's an NPC that moves around, check in the database for the latest location

                if (npc.position) {
                    locations.push({ map: mapName as MapName, x: npc.position[0], y: npc.position[1] })
                } else if (npc.positions) {
                    for (const position of npc.positions) {
                        locations.push({ map: mapName as MapName, x: position[0], y: position[1] })
                    }
                }
            }
        }

        return locations
    }
}


export class PingCompensatedPlayer extends Player {
    async connect(): Promise<unknown> {
        const promise = super.connect()
        return promise.then(async () => { this.pingLoop() })
    }

    protected setNextSkill(skill: SkillName, next: Date): void {
        // Get ping compensation
        let pingCompensation = 0
        if (this.pings.length > 0) {
            pingCompensation = Math.min(...this.pings)
        }

        this.nextSkill.set(skill, new Date(next.getTime() - pingCompensation))
    }

    protected async parseEntities(data: EntitiesData): Promise<void> {
        super.parseEntities(data)

        const pingCompensation = Math.min(...this.pings) / 2

        for (const monster of data.monsters) {
            // Compensate position
            const entity = this.entities.get(monster.id)
            if (!entity || !entity.moving) continue
            const distanceTravelled = entity.speed * pingCompensation / 1000
            const angle = Math.atan2(entity.going_y - entity.y, entity.going_x - entity.x)
            const distanceToGoal = Tools.distance({ x: entity.x, y: entity.y }, { x: entity.going_x, y: entity.going_y })
            if (distanceTravelled > distanceToGoal) {
                entity.moving = false
                entity.x = entity.going_x
                entity.y = entity.going_y
            } else {
                entity.x = entity.x + Math.cos(angle) * distanceTravelled
                entity.y = entity.y + Math.sin(angle) * distanceTravelled
            }

            // Compensate conditions
            for (const condition in entity.s) {
                if (entity.s[condition as ConditionName].ms) {
                    entity.s[condition as ConditionName].ms -= pingCompensation
                }
            }
        }

        for (const player of data.players) {
            // Compensate position
            const entity = this.players.get(player.id)
            if (!entity || !entity.moving) continue
            const distanceTravelled = entity.speed * pingCompensation / 1000
            const angle = Math.atan2(entity.going_y - entity.y, entity.going_x - entity.x)
            const distanceToGoal = Tools.distance({ x: entity.x, y: entity.y }, { x: entity.going_x, y: entity.going_y })
            if (distanceTravelled > distanceToGoal) {
                entity.moving = false
                entity.x = entity.going_x
                entity.y = entity.going_y
            } else {
                entity.x = entity.x + Math.cos(angle) * distanceTravelled
                entity.y = entity.y + Math.sin(angle) * distanceTravelled
            }

            // Compensate conditions
            for (const condition in entity.s) {
                if (entity.s[condition as ConditionName].ms) {
                    entity.s[condition as ConditionName].ms -= pingCompensation
                }
            }
        }
    }

    protected parseCharacter(data: CharacterData): void {
        super.parseCharacter(data)

        const pingCompensation = Math.min(...this.pings) / 2

        // Compensate movement
        if (this.character.moving) {
            const distanceTravelled = this.character.speed * pingCompensation / 1000
            const angle = Math.atan2(this.character.going_y - this.character.y, this.character.going_x - this.character.x)
            const distanceToGoal = Tools.distance({ x: this.character.x, y: this.character.y }, { x: this.character.going_x, y: this.character.going_y })
            if (distanceTravelled > distanceToGoal) {
                this.character.moving = false
                this.character.x = this.character.going_x
                this.character.y = this.character.going_y
            } else {
                this.character.x = this.character.x + Math.cos(angle) * distanceTravelled
                this.character.y = this.character.y + Math.sin(angle) * distanceTravelled
            }
        }

        // Compensate conditions
        for (const condition in this.character.s) {
            if (this.character.s[condition as ConditionName].ms) {
                this.character.s[condition as ConditionName].ms -= pingCompensation
            }
        }
    }

    protected pingLoop(): void {
        if (this.socket.connected) {
            this.sendPing()
            if (this.pings.length > MAX_PINGS / 10) {
                this.timeouts.set("pingLoop", setTimeout(async () => { this.pingLoop() }, PING_EVERY_MS))
            } else {
                this.timeouts.set("pingLoop", setTimeout(async () => { this.pingLoop() }, 1000))
            }
        }
    }
}

export class Mage extends PingCompensatedPlayer {
    // TODO: Add promises
    public blink(x: number, y: number): void {
        const blinkTo = { map: this.character.map, x: x, y: y }
        // TODO: We should have an isWalkable(NodeData) position.
        if (Pathfinder.canWalk(blinkTo, blinkTo)) {
            this.socket.emit("skill", { name: "blink", x: x, y: y })
        }
    }

    /**
     * 
     * @param targets Put in pairs of entity IDs, and how much mp to spend attacking each target. E.g.: [["12345", "100"]]
     */
    public cburst(targets: [string, number][]): Promise<unknown> {
        const cbursted = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]cburst['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                reject(`cburst timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "cburst", targets: targets })
        return cbursted
    }

    public energize(target: string): Promise<unknown> {
        const energized = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]energize['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                reject(`energize timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "energize", id: target })
        return energized
    }

    public magiport(target: string): Promise<unknown> {
        const magiportOfferSent = new Promise((resolve, reject) => {
            const magiportCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "magiport_failed" && data.id == target) {
                        this.socket.removeListener("game_response", magiportCheck)
                        reject(`Magiport for '${target}' failed.`)
                    } else if (data.response == "magiport_sent" && data.id == target) {
                        this.socket.removeListener("game_response", magiportCheck)
                        resolve(`Magiport request sent to ${target}.`)
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("game_response", magiportCheck)
                reject(`magiport timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("game_response", magiportCheck)
        })

        this.socket.emit("skill", { name: "magiport", id: target })
        return magiportOfferSent
    }
}

export class Merchant extends PingCompensatedPlayer {
    public closeMerchantStand(): Promise<unknown> {
        if (!this.character.stand) return Promise.resolve() // It's already closed

        const closed = new Promise((resolve, reject) => {
            const checkStand = (data: CharacterData) => {
                if (!data.stand) {
                    this.socket.removeListener("player", checkStand)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", checkStand)
                reject(`closeMerchantStand timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", checkStand)
        })

        this.socket.emit("merchant", { close: 1 })
        return closed
    }

    // TODO: Add promises
    public listForSale(itemPos: number, tradeSlot: TradeSlotType, price: number, quantity = 1): unknown {
        const itemInfo = this.character.items[itemPos]
        if (!itemInfo) return Promise.reject(`We do not have an item in slot ${itemPos}`)

        this.socket.emit("equip", {
            num: itemPos,
            q: quantity,
            slot: tradeSlot,
            price: price
        })
    }

    public mluck(target: string): Promise<unknown> {
        if (target !== this.character.id) {
            const player = this.players.get(target)
            if (!player) return Promise.reject(`Could not find ${target} to mluck.`)
            if (player.npc) return Promise.reject(`${target} is an NPC. You can't mluck NPCs.`)
            if (player.s.mluck && player.s.mluck.strong && player.s.mluck.f !== this.character.id) return Promise.reject(`${target} has a strong mluck from ${player.s.mluck.f}.`)
        }

        const mlucked = new Promise((resolve, reject) => {
            const mluckCheck = (data: EntitiesData) => {
                for (const player of data.players) {
                    if (player.id == target
                        && player.s.mluck
                        && player.s.mluck.f == this.character.id) {
                        this.socket.removeListener("entities", mluckCheck)
                        this.socket.removeListener("game_response", failCheck)
                        resolve()
                    }
                }
            }

            const failCheck = async (data: GameResponseData) => {
                if (typeof data == "string") {
                    if (data == "skill_too_far") {
                        this.socket.removeListener("entities", mluckCheck)
                        this.socket.removeListener("game_response", failCheck)
                        await this.requestPlayerData()
                        reject(`We are too far from ${target} to mluck.`)
                    } else if (data == "no_level") {
                        this.socket.removeListener("entities", mluckCheck)
                        this.socket.removeListener("game_response", failCheck)
                        reject("We aren't a high enough level to use mluck.")
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("entities", mluckCheck)
                this.socket.removeListener("game_response", failCheck)
                reject(`mluck timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("entities", mluckCheck)
            this.socket.on("game_response", failCheck)
        })
        this.socket.emit("skill", { name: "mluck", id: target })
        return mlucked
    }

    public openMerchantStand(): Promise<unknown> {
        if (this.character.stand) return Promise.resolve() // It's already open

        // Find the stand
        const stand = this.locateItem("stand0")
        if (!stand) return Promise.reject("Could not find merchant stand ('stand0') in inventory.")

        const opened = new Promise((resolve, reject) => {
            const checkStand = (data: CharacterData) => {
                if (data.stand) {
                    this.socket.removeListener("player", checkStand)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", checkStand)
                reject(`openMerchantStand timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", checkStand)
        })

        this.socket.emit("merchant", { num: stand })
        return opened
    }
}

export class Priest extends PingCompensatedPlayer {
    public curse(target: string): Promise<unknown> {
        const curseStarted = new Promise<string[]>((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]curse['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                reject(`curse timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "curse", id: target })
        return curseStarted
    }

    public heal(id: string): Promise<string> {
        // if (!this.game.entities.has(id) && !this.game.players.has(id)) return Promise.reject(`No Entity with ID '${id}'`)

        const healStarted = new Promise<string>((resolve, reject) => {
            const deathCheck = (data: DeathData) => {
                if (data.id == id) {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("game_response", failCheck)
                    this.socket.removeListener("death", deathCheck)
                    reject(`Entity ${id} not found`)
                }
            }
            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "disabled") {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Heal on ${id} failed (disabled).`)
                    } else if (data.response == "attack_failed" && data.id == id) {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Heal on ${id} failed.`)
                    } else if (data.response == "too_far" && data.id == id) {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`${id} is too far away to heal (dist: ${data.dist}).`)
                    } else if (data.response == "cooldown" && data.id == id) {
                        this.socket.removeListener("action", attackCheck)
                        this.socket.removeListener("game_response", failCheck)
                        this.socket.removeListener("death", deathCheck)
                        reject(`Heal on ${id} failed due to cooldown (ms: ${data.ms}).`)
                    }
                }
            }
            const attackCheck = (data: ActionData) => {
                if (data.attacker == this.character.id && data.target == id && data.type == "heal") {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("game_response", failCheck)
                    this.socket.removeListener("death", deathCheck)
                    resolve(data.pid)
                }
            }
            setTimeout(() => {
                this.socket.removeListener("action", attackCheck)
                this.socket.removeListener("game_response", failCheck)
                this.socket.removeListener("death", deathCheck)
                reject(`heal timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", attackCheck)
            this.socket.on("game_response", failCheck)
            this.socket.on("death", deathCheck)
        })

        this.socket.emit("heal", { id: id })
        return healStarted
    }

    public partyHeal(): Promise<string[]> {
        const healStarted = new Promise<string[]>((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]partyheal['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                reject(`partyHeal timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "partyheal" })
        return healStarted
    }
}

/** Implement functions that only apply to rangers */
export class Ranger extends PingCompensatedPlayer {
    public fiveShot(target1: string, target2: string, target3: string, target4: string, target5: string): Promise<string[]> {
        const attackStarted = new Promise<string[]>((resolve, reject) => {
            const projectiles: string[] = []

            const attackCheck = (data: ActionData) => {
                if (data.attacker == this.character.id
                    && data.type == "5shot"
                    && (data.target == target1 || data.target == target2 || data.target == target3 || data.target == target4 || data.target == target5)) {
                    projectiles.push(data.pid)
                }
            }

            // TODO: Confirm that the cooldown is always sent after the projectiles
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]5shot['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve(projectiles)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("action", attackCheck)
                this.socket.removeListener("eval", cooldownCheck)
                reject(`5shot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", attackCheck)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", {
            name: "5shot",
            ids: [target1, target2, target3, target4, target5]
        })
        return attackStarted
    }

    public huntersMark(target: string): Promise<unknown> {
        const marked = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]huntersmark['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve()
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                reject(`supershot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
        })
        this.socket.emit("skill", {
            name: "huntersmark",
            id: target
        })
        return marked
    }

    public piercingShot(target: string): Promise<string> {
        if (this.G.skills.piercingshot.mp > this.character.mp) return Promise.reject("Not enough MP to use piercingShot")

        const piercingShotStarted = new Promise<string>((resolve, reject) => {
            let projectile: string

            const attackCheck = (data: ActionData) => {
                if (data.attacker == this.character.id
                    && data.type == "piercingshot"
                    && data.target == target) {
                    projectile = data.pid
                }
            }

            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]piercingshot['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve(projectile)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("action", attackCheck)
                this.socket.removeListener("eval", cooldownCheck)
                reject(`piercingshot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", attackCheck)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "piercingshot", id: target })
        return piercingShotStarted
    }

    public superShot(target: string): Promise<string> {
        if (this.G.skills.supershot.mp > this.character.mp) return Promise.reject("Not enough MP to use superShot")

        const superShotStarted = new Promise<string>((resolve, reject) => {
            let projectile: string

            const attackCheck = (data: ActionData) => {
                if (data.attacker == this.character.id
                    && data.type == "supershot"
                    && data.target == target) {
                    projectile = data.pid
                }
            }

            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]supershot['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve(projectile)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("action", attackCheck)
                this.socket.removeListener("eval", cooldownCheck)
                reject(`supershot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", attackCheck)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", { name: "supershot", id: target })
        return superShotStarted
    }

    public threeShot(target1: string, target2: string, target3: string): Promise<string[]> {
        const attackStarted = new Promise<string[]>((resolve, reject) => {
            const projectiles: string[] = []

            const attackCheck = (data: ActionData) => {
                if (data.attacker == this.character.id
                    && data.type == "3shot"
                    && (data.target == target1 || data.target == target2 || data.target == target3)) {
                    projectiles.push(data.pid)
                }
            }

            // TODO: Confirm that the cooldown is always sent after the projectiles
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]3shot['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("action", attackCheck)
                    this.socket.removeListener("eval", cooldownCheck)
                    resolve(projectiles)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("action", attackCheck)
                this.socket.removeListener("eval", cooldownCheck)
                reject(`3shot timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", attackCheck)
            this.socket.on("eval", cooldownCheck)
        })

        this.socket.emit("skill", {
            name: "3shot",
            ids: [target1, target2, target3]
        })
        return attackStarted
    }
}

export class Warrior extends PingCompensatedPlayer {
    // TODO: Investigate why the cooldown check doesn't work.
    public agitate(): Promise<unknown> {
        const agitated = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]agitate['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", failCheck)
                    resolve()
                }
            }

            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object" && data.response == "cooldown" && data.skill == "agitate") {
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", failCheck)
                    reject(`Agitate failed due to cooldown (ms: ${data.ms}).`)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                this.socket.removeListener("game_response", failCheck)
                reject(`agitate timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
            this.socket.on("game_response", failCheck)
        })

        this.socket.emit("skill", {
            name: "agitate"
        })
        return agitated
    }

    public charge(): Promise<unknown> {
        const charged = new Promise((resolve, reject) => {
            const successCheck = (data: CharacterData) => {
                if (!data.hitchhikers) return
                for (const [event, datum] of data.hitchhikers) {
                    if (event == "game_response" && datum.response == "skill_success" && datum.name == "charge") {
                        this.socket.removeListener("player", successCheck)
                        this.socket.removeListener("game_response", failCheck)
                        resolve()
                        return
                    }
                }
            }

            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "cooldown" && data.skill == "charge") {
                        this.socket.removeListener("player", successCheck)
                        this.socket.removeListener("game_response", failCheck)
                        reject(`Charge failed due to cooldown (ms: ${data.ms}).`)
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", successCheck)
                this.socket.removeListener("game_response", failCheck)
                reject(`charge timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", successCheck)
            this.socket.on("game_response", failCheck)
        })

        this.socket.emit("skill", { name: "charge" })
        return charged
    }

    public cleave(): Promise<unknown> {
        if (this.G.skills.cleave.mp > this.character.mp) return Promise.reject("Not enough MP to use cleave")

        const cleaved = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]cleave['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", failCheck)
                    resolve()
                }
            }

            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object" && data.response == "cooldown" && data.skill == "cleave") {
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", failCheck)
                    reject(`Cleave failed due to cooldown (ms: ${data.ms}).`)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                this.socket.removeListener("game_response", failCheck)
                reject(`cleave timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
            this.socket.on("game_response", failCheck)
        })

        this.socket.emit("skill", {
            name: "cleave"
        })
        return cleaved
    }

    public hardshell(): Promise<unknown> {
        const hardshelled = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]hardshell['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("player", successCheck)
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", responseCheck)
                    resolve()
                }
            }

            const successCheck = (data: CharacterData) => {
                if (!data.hitchhikers) return
                for (const [event, datum] of data.hitchhikers) {
                    if (event == "game_response" && datum.response == "skill_success" && datum.name == "hardshell") {
                        this.socket.removeListener("player", successCheck)
                        this.socket.removeListener("eval", cooldownCheck)
                        this.socket.removeListener("game_response", responseCheck)
                        resolve()
                        return
                    }
                }
            }

            const responseCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "cooldown" && data.skill == "hardshell") {
                        this.socket.removeListener("player", successCheck)
                        this.socket.removeListener("eval", cooldownCheck)
                        this.socket.removeListener("game_response", responseCheck)
                        reject(`Hardshell failed due to cooldown (ms: ${data.ms}).`)
                    } else if (data.response == "skill_success" && data.name == "hardshell") {
                        this.socket.removeListener("player", successCheck)
                        this.socket.removeListener("eval", cooldownCheck)
                        this.socket.removeListener("game_response", responseCheck)
                        resolve()
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("player", successCheck)
                this.socket.removeListener("eval", cooldownCheck)
                this.socket.removeListener("game_response", responseCheck)
                reject(`hardshell timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("player", successCheck)
            this.socket.on("eval", cooldownCheck)
            this.socket.on("game_response", responseCheck)
        })

        this.socket.emit("skill", {
            name: "hardshell"
        })
        return hardshelled
    }

    // TODO: Return ids of those monsters & players that are now stomped
    public stomp(): Promise<unknown> {
        const stomped = new Promise((resolve, reject) => {
            const cooldownCheck = (data: EvalData) => {
                if (/skill_timeout\s*\(\s*['"]stomp['"]\s*,?\s*(\d+\.?\d+?)?\s*\)/.test(data.code)) {
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", failCheck)
                    resolve()
                }
            }

            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object" && data.response == "cooldown" && data.skill == "stomp") {
                    this.socket.removeListener("eval", cooldownCheck)
                    this.socket.removeListener("game_response", failCheck)
                    reject(`Stomp failed due to cooldown (ms: ${data.ms}).`)
                }
            }

            setTimeout(() => {
                this.socket.removeListener("eval", cooldownCheck)
                this.socket.removeListener("game_response", failCheck)
                reject(`stomp timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("eval", cooldownCheck)
            this.socket.on("game_response", failCheck)
        })

        this.socket.emit("skill", {
            name: "stomp"
        })
        return stomped
    }

    // TODO: Investigate if cooldown is before or after the "action" event. We are getting lots of "failed due to cooldowns"
    public taunt(target: string): Promise<string> {
        const tauntStarted = new Promise<string>((resolve, reject) => {
            const tauntCheck = (data: ActionData) => {
                if (data.attacker == this.character.id
                    && data.type == "taunt"
                    && data.target == target) {
                    resolve(data.pid)
                    this.socket.removeListener("action", tauntCheck)
                }
            }

            const failCheck = (data: GameResponseData) => {
                if (typeof data == "object") {
                    if (data.response == "no_target") {
                        this.socket.removeListener("action", tauntCheck)
                        this.socket.removeListener("game_response", failCheck)
                        reject(`Taunt on ${target} failed (no target).`)
                    } else if (data.response == "too_far" && data.id == target) {
                        this.socket.removeListener("action", tauntCheck)
                        this.socket.removeListener("game_response", failCheck)
                        reject(`${target} is too far away to taunt (dist: ${data.dist}).`)
                    } else if (data.response == "cooldown" && data.id == target) {
                        this.socket.removeListener("action", tauntCheck)
                        this.socket.removeListener("game_response", failCheck)
                        reject(`Taunt on ${target} failed due to cooldown (ms: ${data.ms}).`)
                    }
                }
            }

            setTimeout(() => {
                this.socket.removeListener("action", tauntCheck)
                this.socket.removeListener("game_response", failCheck)
                reject(`taunt timeout (${TIMEOUT}ms)`)
            }, TIMEOUT)
            this.socket.on("action", tauntCheck)
            this.socket.on("game_response", failCheck)
        })

        this.socket.emit("skill", { name: "taunt", id: target })
        return tauntStarted
    }

    // TODO: Add promises and checks
    public warcry() {
        this.socket.emit("skill", { name: "warcry" })
    }
}

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
        for (const characterName in this.players) this.stopCharacter(characterName)
    }

    static async stopAllObservers(): Promise<void> {
        for (const region in this.observers)
            for (const id in this.observers[region])
                await this.stopObserver(region as ServerRegion, id as ServerIdentifier)
    }

    public static async stopCharacter(characterName: string): Promise<void> {
        await this.players[characterName].disconnect()
        delete this.players[characterName]
    }

    public static async stopObserver(region: ServerRegion, id: ServerIdentifier): Promise<void> {
        this.observers[this.servers[region][id].key].socket.close()
        delete this.players[region][id]
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