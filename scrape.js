const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { JSDOM } = require("jsdom");
const { Configuration, OpenAIApi } = require("openai");
const DbConnection = require("../pg_connect");
const fs = require("fs");
let pg_client = DbConnection.Get();
const { query } = require("../helpers/query");
const { app } = require("../app");

const configuration = new Configuration({
  organization: "MY-ORG",
  apiKey: process.env.AI_KEY,
});

const openai = new OpenAIApi(configuration);

const ScrapflyOptions = {
  key: "MY-KEY",
};

let logoElement =
  "https://res.cloudinary.com/incognito-apps-inc/image/upload/v1681224990/blank_glassdoor_dihk33.png";
const team_id = uuidv4();
let slack_ts = null;
let loading_channel = null;
let slack_token = null;

const BASE_CONFIG = {
  country: "US",
  asp: true,
  cookies: { tldp: "1" },
  proxy_pool: "public_residential_pool",
};

function extractID(url) {
  const regexPattern = /(?<=(-E|EI_))\d+/;
  const match = url.match(regexPattern);

  if (match) {
    return match[0];
  } else {
    return null;
  }
}

function extractName(url) {
  const regexPattern =
    /(?<=Reviews\/|Overview\/Working-at-)([^.-]+(?:-[^.-]+)*)(?=-EI(?:_|\.|$)|-Reviews)/;
  const match = url.match(regexPattern);

  if (match) {
    return match[0].replace(/-/g, " ");
  } else {
    return null;
  }
}

function extract_apollo_state(html) {
  try {
    const dom = new JSDOM(html);
    const scriptTags = dom.window.document.querySelectorAll("script");
    let apolloState = null;

    scriptTags.forEach((script) => {
      if (script.textContent.includes("squareLogoUrl")) {
        const logoUrlRegex =
          /"squareLogoUrl\({\\"size\\":\\"REGULAR\\"}\)":"([^"]+)"/;
        const match = script.textContent.match(logoUrlRegex);
        if (match) {
          logoElement = match[1].replace(/\\u002F/g, "/");
        }
      }

      if (script.textContent.includes("window.appCache")) {
        const apolloStateRegex = /apolloState":\s*({.+})};/;
        const match = script.textContent.match(apolloStateRegex);
        if (match) {
          apolloState = JSON.parse(match[1]);
        }
      }
    });

    if (!apolloState) {
      throw new Error("Could not find apolloState data in HTML source");
    }

    return apolloState;
  } catch (e) {
    console.log("Error extracting apollo state: ", e);
  }
}

function change_page(url, page) {
  if (url.match(/_P\d+.htm/)) {
    return url.replace(/(?:_P\d+)*.htm/, `_P${page}.htm`);
  } else {
    return url.replace(/.htm/, `_P${page}.htm`);
  }
}

function parse_reviews(html) {
  try {
    const apolloState = extract_apollo_state(html);
    if (!apolloState) {
      return null;
    }
    const xhrCache = apolloState.ROOT_QUERY;
    const reviews = Object.values(xhrCache).find(
      (v) => v && v.reviews && v.__typename === "EmployerReviews"
    );
    return reviews;
  } catch (e) {
    console.log("Error parsing reviews: ", e);
  }
}

async function getScrapfly(url) {
  return (
    await axios.get("https://api.scrapfly.io/scrape", {
      params: { ...ScrapflyOptions, ...BASE_CONFIG, url: url },
    })
  ).data.result.content;
}

async function scrape_reviews(employer, employer_id, max_pages = null) {
  let all_reviews = {};
  console.log(`scraping reviews for ${employer}`);
  const first_page_url = `https://www.glassdoor.com/Reviews/${employer}-Reviews-E${employer_id}.htm`;

  let first_page;
  let retries = 3;
  let total_pages = 0;

  while (retries > 0) {
    try {
      first_page = await getScrapfly(first_page_url);
      const dom = new JSDOM(first_page);
      const { window } = dom;
      let logo_search = window.document.querySelector(".lgSqLogo img");
      if (logo_search) {
        logoElement = logo_search.src;
      }
      console.log(`scraping first page of reviews for ${employer}`);
      const apollo_data = parse_reviews(first_page);
      if (
        apollo_data &&
        apollo_data.reviews &&
        apollo_data.reviews.length > 0
      ) {
        all_reviews = apollo_data;
        total_pages = apollo_data.numberOfPages;
        console.log(`found ${total_pages} pages of reviews`);
        if (max_pages && max_pages < total_pages) {
          total_pages = max_pages;
        }
        break;
      } else {
        retries -= 1;
        console.log("No reviews found on first page. Trying again...");
        if (retries === 0) {
          console.log(
            "Max retries reached for the first page. Aborting scraping process."
          );
          await app.client.chat.postMessage({
            token: slack_token,
            channel: loading_channel,
            text: `Glassdoor report failed for ${employer}...`,
          });
          return null;
        }
      }
    } catch (e) {
      console.log(`Error while scraping first page: ${e}. Retrying...`);
      retries -= 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (retries === 0) {
        await app.client.chat.postMessage({
          token: slack_token,
          channel: loading_channel,
          text: `Glassdoor report failed for ${employer}...`,
        });
        console.log(
          "Max retries reached for the first page. Aborting scraping process."
        );
        return null;
      }
    }
  }

  await app.client.chat.update({
    token: slack_token,
    channel: loading_channel,
    ts: slack_ts,
    text: `Got page 1 reviews for ${employer}...`,
  });

  if (total_pages > 15) {
    total_pages = 15;
  }

  let failedScrape = false;

  for (let page = 2; page <= total_pages; page++) {
    let retries = 3;

    while (retries > 0) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const result = await getScrapfly(change_page(first_page_url, page));
        const parsed_reviews = parse_reviews(result);

        if (parsed_reviews && parsed_reviews.reviews) {
          all_reviews.reviews.push(...parsed_reviews.reviews);
          console.log(`scraped page ${page} of ${total_pages}`);
          await app.client.chat.update({
            token: slack_token,
            channel: loading_channel,
            ts: slack_ts,
            text: `Got page ${page} reviews for ${employer}...`,
          });
          break;
        } else {
          console.log("No reviews found on ", page, " page. Trying again...");
        }
      } catch (e) {
        console.log(`Error while scraping page ${page}: ${e}. Retrying...`);
        retries -= 1;
      }
    }

    if (retries === 0) {
      failedScrape = true;
      console.log("Scraping failed after 3 retries. Exiting...");
      break;
    }
  }

  return { reviews: all_reviews };
}

const glassdoor_report = async (url) => {
  try {
    const emp_name = extractName(url);
    const emp_id = extractID(url);

    let tenant_res;
    if (process.env.PROD === "true") {
      tenant_res = await query(
        pg_client,
        "SELECT * FROM tenants WHERE team_id = $1;",
        ["T01GM777VLH"]
      );
      loading_channel = "C036PQK3DHR";
      slack_token = tenant_res.rows[0].installation.bot.token;
    } else {
      tenant_res = await query(
        pg_client,
        "SELECT * FROM tenants WHERE team_id = $1;",
        ["T01HP7H5HME"]
      );
      loading_channel = "C01HP7H61PS";
      slack_token = tenant_res.rows[0].installation.bot.token;
    }

    let loading_message = await app.client.chat.postMessage({
      token: slack_token,
      channel: loading_channel,
      text: `Starting Glassdoor report for ${emp_name}...`,
    });

    slack_ts = loading_message.ts;

    let reviews_data = await scrape_reviews(emp_name, emp_id);
    reviews_data = reviews_data.reviews;

    if (reviews_data === null || !reviews_data.reviews) {
      console.log("Scraping process was aborted. No data to process.");
      return;
    }

    reviews_data.reviews = reviews_data.reviews.filter(
      (review) => review.reviewDateTime > "2022-01-01T15:02:27.760"
    );

    // insert reviews into glassdoor_reviews table
    for (const review of reviews_data.reviews) {
      if (review.cons !== null && review.cons.length > 0) {
        await query(
          pg_client,
          "INSERT INTO glassdoor_reviews (type, text, team_id, date_posted, glassdoor_id, tags) VALUES ($1, $2, $3, $4, $5, $6);",
          [
            "cons",
            review.cons,
            team_id,
            review.reviewDateTime,
            review.reviewId,
            [],
          ]
        );
      }

      if (review.pros !== null && review.pros.length > 0) {
        await query(
          pg_client,
          "INSERT INTO glassdoor_reviews (type, text, team_id, date_posted, glassdoor_id, tags) VALUES ($1, $2, $3, $4, $5, $6);",
          [
            "pros",
            review.pros,
            team_id,
            review.reviewDateTime,
            review.reviewId,
            [],
          ]
        );
      }

      if (review.advice !== null && review.advice.length > 0) {
        await query(
          pg_client,
          "INSERT INTO glassdoor_reviews (type, text, team_id, date_posted, glassdoor_id, tags) VALUES ($1, $2, $3, $4, $5, $6);",
          [
            "advice",
            review.advice,
            team_id,
            review.reviewDateTime,
            review.reviewId,
            [],
          ]
        );
      }
    }

    try {
      const res = await query(
        pg_client,
        `
      INSERT INTO glassdoor_report (
          team_name,
          uuid,
          team_id,
          "overallRating", 
          "recommendToFriendRating", 
          "ceoRating", 
          logo, 
          cultureandvaluesrating, 
          diversityandinclusionrating, 
          careeropportunitiesrating, 
          worklifebalancerating, 
          seniormanagementrating, 
          compensationandbenefitsrating, 
          businessoutlookrating, 
          ceoratingscount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `,
        [
          emp_name,
          team_id,
          null,
          reviews_data.ratings.overallRating,
          reviews_data.ratings.recommendToFriendRating,
          reviews_data.ratings.ceoRating,
          logoElement,
          reviews_data.ratings.cultureAndValuesRating,
          reviews_data.ratings.diversityAndInclusionRating,
          reviews_data.ratings.careerOpportunitiesRating,
          reviews_data.ratings.workLifeBalanceRating,
          reviews_data.ratings.seniorManagementRating,
          reviews_data.ratings.compensationAndBenefitsRating,
          reviews_data.ratings.businessOutlookRating,
          reviews_data.ratings.ceoRatingsCount,
        ]
      );
      console.log("Rows affected:", res.rowCount);
    } catch (e) {
      console.log("Error during SQL query execution:", e);
      await app.client.chat.postMessage({
        token: slack_token,
        channel: loading_channel,
        text: `Glassdoor report failed for ${emp_name}`,
      });
    }
  } catch (err) {
    await app.client.chat.postMessage({
      token: slack_token,
      channel: loading_channel,
      text: `Glassdoor report failed`,
    });
    console.log(`Something went wrong w/ glassdoor_report team`, err);
  }
};

module.exports = { glassdoor_report };
