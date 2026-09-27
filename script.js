const API = {
    users: "https://users.roblox.com",
    thumbnails: "https://thumbnails.roblox.com",
    friends: "https://friends.roblox.com",
    groups: "https://groups.roblox.com",
    badges: "https://accountinformation.roblox.com"
};


const usernameInput =
    document.getElementById("usernameInput");

const analyzeButton =
    document.getElementById("analyzeButton");

const results =
    document.getElementById("results");

const loading =
    document.getElementById("loading");

const errorBox =
    document.getElementById("error");


analyzeButton.addEventListener(
    "click",
    analyzeAccount
);


usernameInput.addEventListener(
    "keydown",
    event => {
        if (event.key === "Enter") {
            analyzeAccount();
        }
    }
);


async function fetchJSON(url) {

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}`
        );
    }

    return response.json();
}


/*
    Convert username -> Roblox user.
*/

async function getUser(username) {

    const response = await fetch(
        `${API.users}/v1/usernames/users`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                usernames: [username],
                excludeBannedUsers: false
            })
        }
    );

    if (!response.ok) {
        throw new Error(
            "Could not contact Roblox."
        );
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
        throw new Error(
            "Roblox user was not found."
        );
    }

    return data.data[0];
}


/*
    Get full profile.
*/

async function getProfile(userId) {

    return fetchJSON(
        `${API.users}/v1/users/${userId}`
    );
}


/*
    Get avatar thumbnail.
*/

async function getAvatar(userId) {

    const data = await fetchJSON(
        `${API.thumbnails}/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );

    return data.data?.[0]?.imageUrl || "";
}


/*
    Get friends.
*/

async function getFriends(userId) {

    const data = await fetchJSON(
        `${API.friends}/v1/users/${userId}/friends`
    );

    return data.data || [];
}


/*
    Followers/following counts.

    These endpoints can change independently of the
    user profile API, so failures are handled separately.
*/

async function getFollowers(userId) {

    try {

        const data = await fetchJSON(
            `${API.friends}/v1/users/${userId}/followers/count`
        );

        return data.count ?? null;

    } catch {

        return null;
    }
}


async function getFollowing(userId) {

    try {

        const data = await fetchJSON(
            `${API.friends}/v1/users/${userId}/followings/count`
        );

        return data.count ?? null;

    } catch {

        return null;
    }
}


/*
    Groups.
*/

async function getGroups(userId) {

    try {

        const data = await fetchJSON(
            `${API.groups}/v2/users/${userId}/groups/roles`
        );

        return data.data || [];

    } catch {

        return [];
    }
}


/*
    Roblox badges.
*/

async function getBadges(userId) {

    try {

        const data = await fetchJSON(
            `${API.badges}/v1/users/${userId}/roblox-badges?limit=100&sortOrder=Asc`
        );

        return data.data || [];

    } catch {

        return [];
    }
}


/*
    Account age.
*/

function getAccountAge(created) {

    const createdDate =
        new Date(created);

    const now =
        new Date();

    const milliseconds =
        now - createdDate;

    return Math.floor(
        milliseconds /
        (1000 * 60 * 60 * 24)
    );
}


/*
    Score calculation.

    This is deliberately a heuristic rather than
    pretending to be a genuine probability model.
*/

function calculateScore(data) {

    const signals = [];

    let score = 0;


    /*
        Account age
    */

    let ageScore = 0;

    if (data.ageDays < 7) {
        ageScore = 25;
    }

    else if (data.ageDays < 30) {
        ageScore = 20;
    }

    else if (data.ageDays < 90) {
        ageScore = 12;
    }

    else if (data.ageDays < 180) {
        ageScore = 5;
    }

    signals.push({
        name: "Account age",
        value: `${data.ageDays} days`,
        score: ageScore,
        level:
            ageScore >= 20
                ? "danger"
                : ageScore >= 10
                    ? "warning"
                    : "good"
    });

    score += ageScore;


    /*
        Friends
    */

    let friendScore = 0;

    if (data.friends === 0) {
        friendScore = 15;
    }

    else if (data.friends <= 3) {
        friendScore = 12;
    }

    else if (data.friends <= 10) {
        friendScore = 7;
    }

    signals.push({
        name: "Friend count",
        value: `${data.friends}`,
        score: friendScore,
        level:
            friendScore >= 12
                ? "danger"
                : friendScore >= 7
                    ? "warning"
                    : "good"
    });

    score += friendScore;


    /*
        Followers/following ratio
    */

    let socialScore = 0;

    if (
        data.followers !== null &&
        data.following !== null
    ) {

        if (
            data.followers === 0 &&
            data.following >= 25
        ) {
            socialScore = 15;
        }

        else if (
            data.followers <= 3 &&
            data.following >= 15
        ) {
            socialScore = 10;
        }

        else if (
            data.followers < data.following / 5
        ) {
            socialScore = 6;
        }
    }

    signals.push({
        name: "Follower/following pattern",
        value:
            data.followers === null
                ? "Unavailable"
                : `${data.followers} followers / ${data.following} following`,
        score: socialScore,
        level:
            socialScore >= 10
                ? "danger"
                : socialScore >= 5
                    ? "warning"
                    : "good"
    });

    score += socialScore;


    /*
        Groups
    */

    let groupScore = 0;

    if (data.groups === 0) {
        groupScore = 7;
    }

    else if (data.groups <= 2) {
        groupScore = 4;
    }

    signals.push({
        name: "Groups",
        value: `${data.groups}`,
        score: groupScore,
        level:
            groupScore >= 7
                ? "warning"
                : "good"
    });

    score += groupScore;


    /*
        Badges
    */

    let badgeScore = 0;

    if (
        data.badges <= 2 &&
        data.ageDays > 14
    ) {
        badgeScore = 6;
    }

    else if (
        data.badges <= 5 &&
        data.ageDays > 60
    ) {
        badgeScore = 3;
    }

    signals.push({
        name: "Roblox badges",
        value: `${data.badges}`,
        score: badgeScore,
        level:
            badgeScore >= 6
                ? "warning"
                : "good"
    });

    score += badgeScore;


    /*
        Inventory

        Frontend-only version can't reliably inspect the
        full modern inventory API without a backend/API
        credential, so leave this at zero for now.
    */

    const inventoryScore = 0;

    signals.push({
        name: "Inventory",
        value: "Backend required",
        score: inventoryScore,
        level: "good"
    });


    /*
        Normalize to 100.
    */

    score = Math.min(
        100,
        Math.round(score)
    );


    return {
        score,
        signals
    };
}


/*
    Render indicator list.
*/

function renderIndicators(signals) {

    const container =
        document.getElementById("indicators");

    container.innerHTML = "";


    signals.forEach(signal => {

        const div =
            document.createElement("div");

        div.className =
            `indicator ${signal.level}`;


        div.innerHTML = `
            <div class="indicator-left">
                <div class="indicator-dot"></div>

                <span class="indicator-name">
                    ${escapeHTML(signal.name)}
                </span>
            </div>

            <span class="indicator-value">
                ${escapeHTML(signal.value)}
            </span>
        `;


        container.appendChild(div);
    });
}


/*
    Render score breakdown.
*/

function renderBreakdown(signals) {

    const container =
        document.getElementById("breakdown");

    container.innerHTML = "";


    const maxPossible = 68;


    signals.forEach(signal => {

        const percentage =
            Math.min(
                100,
                (signal.score / maxPossible) * 100
            );


        const div =
            document.createElement("div");

        div.className =
            "breakdown-item";


        div.innerHTML = `
            <div class="breakdown-top">
                <span>
                    ${escapeHTML(signal.name)}
                </span>

                <span>
                    +${signal.score}
                </span>
            </div>

            <div class="bar">
                <div
                    class="bar-fill"
                    style="width:${percentage}%"
                ></div>
            </div>
        `;


        container.appendChild(div);
    });
}


/*
    Update score UI.
*/

function renderScore(score) {

    document.getElementById(
        "score"
    ).textContent = score;

    document.getElementById(
        "ringScore"
    ).textContent = score;


    let assessment;


    if (score < 25) {

        assessment =
            "Few alt-like indicators";

    }

    else if (score < 50) {

        assessment =
            "Some alt-like indicators";

    }

    else if (score < 75) {

        assessment =
            "Strong alt-like indicators";

    }

    else {

        assessment =
            "Very strong alt-like indicators";
    }


    document.getElementById(
        "assessment"
    ).textContent = assessment;


    const degrees =
        score * 3.6;


    document.getElementById(
        "scoreRing"
    ).style.background = `
        conic-gradient(
            var(--accent) ${degrees}deg,
            var(--border) ${degrees}deg
        )
    `;

    document.getElementById(
        "scoreRing"
    ).style.setProperty(
        "--score",
        score
    );
}


/*
    Main analyzer.
*/

async function analyzeAccount() {

    const username =
        usernameInput.value.trim();


    if (!username) {

        showError(
            "Enter a Roblox username."
        );

        return;
    }


    errorBox.classList.add("hidden");
    results.classList.add("hidden");
    loading.classList.remove("hidden");


    try {

        /*
            Resolve username.
        */

        const user =
            await getUser(username);


        /*
            Request independent data in parallel.
        */

        const [
            profile,
            avatar,
            friends,
            followers,
            following,
            groups,
            badges
        ] = await Promise.all([

            getProfile(user.id),

            getAvatar(user.id),

            getFriends(user.id),

            getFollowers(user.id),

            getFollowing(user.id),

            getGroups(user.id),

            getBadges(user.id)

        ]);


        const ageDays =
            getAccountAge(profile.created);


        const data = {

            userId: user.id,

            username: profile.name,

            displayName:
                profile.displayName,

            description:
                profile.description || "",

            created:
                profile.created,

            ageDays,

            friends:
                friends.length,

            followers,

            following,

            groups:
                groups.length,

            badges:
                badges.length

        };


        /*
            Calculate heuristic score.
        */

        const analysis =
            calculateScore(data);


        /*
            Profile
        */

        document.getElementById(
            "avatar"
        ).src = avatar;


        document.getElementById(
            "displayName"
        ).textContent =
            data.displayName;


        document.getElementById(
            "username"
        ).textContent =
            `@${data.username}`;


        document.getElementById(
            "description"
        ).textContent =
            data.description;


        document.getElementById(
            "profileLink"
        ).href =
            `https://www.roblox.com/users/${data.userId}/profile`;


        /*
            Stats
        */

        document.getElementById(
            "accountAge"
        ).textContent =
            `${data.ageDays} days`;


        document.getElementById(
            "friends"
        ).textContent =
            data.friends;


        document.getElementById(
            "followers"
        ).textContent =
            data.followers ?? "N/A";


        document.getElementById(
            "following"
        ).textContent =
            data.following ?? "N/A";


        /*
            Account information
        */

        document.getElementById(
            "userId"
        ).textContent =
            data.userId;


        document.getElementById(
            "created"
        ).textContent =
            new Date(
                data.created
            ).toLocaleDateString();


        document.getElementById(
            "groups"
        ).textContent =
            data.groups;


        document.getElementById(
            "badges"
        ).textContent =
            data.badges;


        /*
            Analysis
        */

        renderScore(
            analysis.score
        );

        renderIndicators(
            analysis.signals
        );

        renderBreakdown(
            analysis.signals
        );


        results.classList.remove(
            "hidden"
        );

    }

    catch (error) {

        console.error(error);

        showError(
            error.message ||
            "Something went wrong."
        );

    }

    finally {

        loading.classList.add(
            "hidden"
        );
    }
}


/*
    Error helper.
*/

function showError(message) {

    errorBox.textContent =
        message;

    errorBox.classList.remove(
        "hidden"
    );
}


/*
    Prevent API/user data from being
    interpreted as HTML.
*/

function escapeHTML(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
