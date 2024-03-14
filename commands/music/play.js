const { SlashCommandBuilder, ChannelType, PermissionsBitField } = require("discord.js");
const playdl = require("play-dl");
const axios = require('axios').default;
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    VoiceConnectionStatus,
    getVoiceConnection,
    AudioPlayerStatus,
} = require("@discordjs/voice");
const fs = require("fs");
const { youtube_api_key } = require('../../config.json')

let resourceList = new Object();
let songNamesList = new Object();
let nextResourceIsAvailable = true;
var statusChannel;
var statusMessage;

module.exports = {
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play any song from Youtube")
        .addStringOption((option) =>
            option
                .setName("song")
                .setDescription("The song you want to play")
                .setRequired(true)
        ),
    async execute(interaction) {
        await interaction.deferReply();
        const channel = interaction.member.voice.channel;
        const request = interaction.options.getString("song");
        const guildId = interaction.guildId;
        const channelList = Array.from(interaction.guild.channels.cache.values());

        var foundStatusChannel = false;
        if (!statusChannel) {
            for (i = 0; i < channelList.length; i++) {
                if (channelList[i].type != ChannelType.GuildText) continue;
                if (channelList[i].name.includes("Lollipop")) {
                    statusChannel = channelList[i];
                    foundStatusChannel = true;
                    break;
                }
            }

            if (!foundStatusChannel) {
                await interaction.guild.channels.create({
                    name: "🎵 Playlist - Lollipop",
                    type: ChannelType.GuildText,
                }).then((chan) => {
                    statusChannel = chan;
                }).catch(console.error);
            }
        }

        console.log(statusChannel.name);


        var currentTitle = '';

        if (!channel) {
            return interaction.editReply(
                "You must be in a voice channel to perform this command."
            );
        }

        var connection = getVoiceConnection(channel.guildId);
        var player;

        if (!connection) {
            connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guildId,
                adapterCreator: channel.guild.voiceAdapterCreator,
            });
            player = createAudioPlayer();
            connection.subscribe(player);
        } else if (connection.joinConfig.channelId !== channel.id) {
            return interaction.editReply(
                "You must be in the same voice channel as the bot to perform this command."
            );
        }

        var url = request;
        var title = null;

        if (!isValidHttpUrl(request)) {
            var yt_info = await playdl.search(request, { limit: 1 });
            url = yt_info[0].url;
            title = yt_info[0].title;
        } else {
            title = await getSongTitleFromURL(url);
        }

        if (isPlaylistUrl(request)) {
            var playlist_info = await playdl.playlist_info(request);
            var videos_info = await playlist_info.all_videos();
            url = videos_info[0].url;
            title = videos_info[0].title;
            videos_info.shift();
            pushPlayListToSongList(videos_info, guildId);
        }

        var stream = await playdl.stream(url);

        const resource = createAudioResource(stream.stream, {
            inputType: stream.type,
        });

        if (!player) {
            player = connection.state.subscription.player;
        }

        title = title ?? request;

        if (player.state.status == "playing") {
            pushNewResource(resource, guildId);
            pushNewSongName(title, guildId);
            await interaction.editReply(
                `Put \`${title}\` in the queue. It is currently at position \`${resourceList[guildId].length}\`.`
            );
        } else {
            await interaction.editReply(`Got it! Playing \`${title}\``);
            currentTitle = title;
            resetResourceList(guildId);
            player.play(resource);
            setStatusChannelName(currentTitle);
        }

        connection.on(
            VoiceConnectionStatus.Disconnected,
            async (oldState, newState) => {
                try {
                    connection.destroy();
                    player.stop();
                    resetResourceList(guildId);
                } catch {
                    console.error;
                }
            }
        );

        player.on("error", (error) => {
            console.error(error);
        });

        player.addListener("stateChange", (oldState, newState) => {
            if (
                nextResourceIsAvailable &&
                newState.status == AudioPlayerStatus.Idle &&
                oldState.status == AudioPlayerStatus.Playing
            ) {
                startNextResourceTimer();
                var [nextResource, nextResourceTitle] = getNextResource(guildId);
                if (nextResource) player.play(nextResource);
                currentTitle = nextResourceTitle;
                setStatusChannelName(currentTitle);
            }
        });
    },
};

function isValidHttpUrl(string) {
    let url;
    try {
        url = new URL(string);
    } catch (_) {
        return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
}

function isPlaylistUrl(string) {
    return isValidHttpUrl(string) && string.includes("playlist");
}

async function pushPlayListToSongList(songList, guildId) {

    for (entry in songList) {
        var url = songList[entry].url;
        var title = songList[entry].title;

        var stream = await playdl.stream(url);
        console.log(stream);

        const resource = createAudioResource(stream.stream, {
            inputType: stream.type,
        });

        pushNewResource(resource, guildId);
        pushNewSongName(title, guildId);
    }
}

function pushNewResource(resource, guildId) {
    if (guildId in resourceList) {
        resourceList[guildId].push(resource);
    } else {
        resourceList[guildId] = new Array();
        resourceList[guildId].push(resource);
    }
}

function pushNewSongName(song, guildId) {
    if (guildId in songNamesList) {
        songNamesList[guildId].push(song);
    } else {
        songNamesList[guildId] = new Array();
        songNamesList[guildId].push(song);
    }
    dumpSongListToJsonFile();
}

function getNextResource(guildId) {
    var res = resourceList[guildId].shift();
    var resTitle = songNamesList[guildId].shift();
    dumpSongListToJsonFile();
    return [res, resTitle];
}

function resetResourceList(guildId) {
    songNamesList[guildId] = new Array();
    resourceList[guildId] = new Array();
    dumpSongListToJsonFile();
}

function startNextResourceTimer() {
    if (!nextResourceIsAvailable) return;
    nextResourceIsAvailable = false;
    setTimeout(() => {
        nextResourceIsAvailable = true;
    }, 100);
}

function dumpSongListToJsonFile() {
    fs.writeFile(
        "song_list.json",
        JSON.stringify(songNamesList),
        function (err) {
            if (err) throw err;
        }
    );
}

async function getSongTitleFromURL(url) {
    var id = url.substring(
        url.indexOf("?v=") + 3
    );
    if (url.includes("&ab_channel")) {
        id = url.substring(
            url.indexOf("?v=") + 3,
            url.lastIndexOf("&")
        );
    }
    var songTitle;
    try {
        const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=id%2C+snippet&id=${id}&key=${youtube_api_key}`);
        songTitle = response["data"]["items"][0]["snippet"]["title"];
    } catch (error) {
        console.error(error);
    }

    return songTitle;
}

function setStatusChannelName(currentTitle) {
    if (!statusMessage) {
        statusChannel.send(`🎵 Now playing: \`${currentTitle}\``).then((msg) => {
            statusMessage = msg;
        }).catch(console.error);
    } else {
        statusMessage.edit(`🎵 Now playing: \`${currentTitle}\``).then().catch(console.error);
    }

    // TODO: cases for when the bot is not playing any song, disconnected, etc
    // deleting the message after the bot disconnects
}