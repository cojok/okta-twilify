#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const inquirer = require("inquirer");
const libPhoneNumber = require("libphonenumber-js");
const mkdirp = require("mkdirp");
const okta = require("@okta/okta-sdk-nodejs");
const program = require("commander");
const twilio = require("twilio");
const untildify = require("untildify");
const MemoryStore = require('@okta/okta-sdk-nodejs/src/memory-store');

const CONFIG_DIR = untildify("~/.config/twilify");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PARAMS = [
    {
        name: "oktaToken",
        message: "Please enter your Okta SSWS token"
    },
    {
        name: "oktaOrgUrl",
        message: "Please enter your Okta Org URL"
    },
    {
        name: "twilioAccountSid",
        message: "Please enter your Twilio Account SID"
    },
    {
        name: "twilioAuthToken",
        message: "Please enter your Twilio Auth Token"
    },
    {
        name: "prefix",
        message: "Please enter your company's phone number prefix (area code)"
    },
    {
        name: "twilioFunctionBaseUrl",
        message: "Please enter your Twilio Functions base URL. This should be something like https://toolbox-bobcat-xxxx.twil.io"
    }
];
const PARAM_NAMES = PARAMS.map(o => o.name);

program
    .version("1.0.0", "-v, --version")
    .option("-i, --init", "Initialize the CLI")
    .option("-o, --okta-token <oktaToken>", "Okta SSWS token")
    .option("-u, --okta-org-url <oktaOrgUrl>", "Okta Org URL")
    .option("-s, --twilio-account-sid <accountSid>", "Twilio Account SID")
    .option("-t, --twilio-auth-token <authToken>", "Twilio Auth Token")
    .option("-p, --prefix <areaCode>", "Your company's phone number prefix, e.g. 415")
    .option("-f, --twilio-function-base-url <twilioFunctionBaseUrl>", "Your Twilio Functions Base URL, e.g. https://toolbox-bobcat-xxxx.twil.io")
    .parse(process.argv)

async function init() {
    let answers = await inquirer.prompt(PARAMS);

    mkdirp.sync(CONFIG_DIR);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(answers, null, 4));

    return answers;
}

function loadConfig() {
    let c = JSON.parse(fs.readFileSync(CONFIG_FILE));

    PARAM_NAMES.forEach(name => {
        c[name] = program[name] ? program[name] : c[name];
    });

    return c;
}

function isConfigValid(config) {
    if (!config) {
        return false;
    }

    PARAM_NAMES.forEach(name => {
        if (!(name in config) || !config[name]) {
            console.error(name + " is a required parameter. Use --help to learn more or --init to create a config file.");
        }
    });

    return true;
}

function cleanPhoneNumber(phoneNumber) {
    let parsedNumber;

    phoneNumber = phoneNumber.replace(/ /g, "");
    parsedNumber = libPhoneNumber.parseNumber(phoneNumber, "DE");

    return libPhoneNumber.formatNumber(parsedNumber, "International").replace(/ /g,"");
}

async function purchaseNumber(client, user, config) {
    let createdNumber, purchasedNumber, resp;

    try {
        // resp = await client.availablePhoneNumbers("DE").local.list({ areaCode: config.prefix });
        resp = await client.availablePhoneNumbers("DE").local.list({ contains: '+4989'});
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

    if (resp.length === 0) {
        console.error("No available phone numbers in the (" + config.prefix + ") area code. Sorry!");
        process.exit(1);
    }

    purchasedNumber = resp[0].phoneNumber;

    try {
        createdNumber = await client.incomingPhoneNumbers.create({
            phoneNumber: purchasedNumber,
            voiceUrl: config.webhookUrl + "/call-forward",
            smsUrl: config.webhookUrl + "/sms-forward"
        });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

    return purchasedNumber;
}

async function getConfig() {
    let config;

    if (program.init) {
        try {
            config = await init();
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    } else {
        try {
            config = loadConfig();
        } catch (err) {}

        if (!isConfigValid(config)) {
            process.exit(1);
        }
    }

    return config;
}

async function main() {
    let oktaClient, twilioClient, config, user;

    config = await getConfig();
    oktaClient = new okta.Client({
        orgUrl: config.oktaOrgUrl,
        token: config.oktaToken,
        requestExecutor: new okta.DefaultRequestExecutor(),
        cacheStore: new MemoryStore({
            keyLimit: 100000,
            expirationPoll: null
        })
    });
    twilioClient = new twilio(config.twilioAccountSid, config.twilioAuthToken);

    oktaClient.listUsers().each(user => {
        let cleanedMobileNumber;

        if (!user.profile.mobilePhone) {
            return;
        }

        // Convert any user-supplied mobile numbers into E.164 format so it'll be
        // internationalized and ready for usage with Twilio.
        cleanedMobileNumber = cleanPhoneNumber(user.profile.mobilePhone);

        if (user.profile.mobilePhone !== cleanedMobileNumber) {
            user.profile.mobilePhone = cleanedMobileNumber;
            user.update();

            console.log("Cleaned up the formatting of a phone number (" + cleanedMobileNumber + ") for " + user.profile.firstName + " " + user.profile.lastName + ".");
        }

        if (!user.profile.primaryPhone) {
            purchaseNumber(twilioClient, user, config)
                .then(purchasedNumber => {
                    user.profile.primaryPhone = purchasedNumber;
                    user.update();

                    console.log("Purchased a new company number (" + purchasedNumber + ") for " + user.profile.firstName + " " + user.profile.lastName + ".");
                });
        }
    });
}

main();
