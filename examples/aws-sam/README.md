# Belltower on AWS Lambda

Deploys the monitor to several AWS regions with AWS SAM. Every region runs
the checks each minute and writes its results to one shared S3 bucket. One
region, the primary, also runs `decide()` and answers heartbeat pings.

What it creates:

| In | Resource | Does |
| --- | --- | --- |
| Every region | `ChecksFunction`, scheduled every minute | Runs the checks, writes `results/{region}/...` |
| Primary region | `DataBucket` | Results (kept 90 days), incidents, heartbeats, `public/status.json`. Kept if the stack is deleted |
| Primary region | `DecideFunction`, scheduled every minute | Confirms outages across regions, opens and resolves incidents, sends alerts through SES, SNS and webhooks |
| Primary region | `HttpFunction` with a function URL | Records heartbeat pings |

Nothing runs between the minute ticks. Run the monitor in a different AWS
account, or at least different regions, from the service it watches.

## Before you deploy

You need an AWS account, the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
and esbuild, which SAM uses to bundle the TypeScript.

1. **Edit `belltower.config.json`.** Replace the example checks with your
   own. Check it with the container adapter's CLI:

   ```sh
   pnpm exec belltower validate --config belltower.config.json --regions us-east-1,eu-west-1
   ```

   This checks the config as the container adapter would run it, which
   can't send SMS. The Lambda functions check it again at cold start with
   what AWS can do, and fail with every problem listed if it doesn't fit.

2. **Store the secrets the config names** in SSM Parameter Store, in the
   primary region, under `/belltower/`:

   ```sh
   aws ssm put-parameter --region us-east-1 --type SecureString \
     --name /belltower/NIGHTLY_EXPORT_TOKEN --value "$(openssl rand -hex 24)"
   aws ssm put-parameter --region us-east-1 --type SecureString \
     --name /belltower/CHAT_WEBHOOK_URL --value "https://hooks.example.com/..."
   ```

   Checks in other regions read secrets such as `basicAuth` from their own
   region's Parameter Store, so put those in every region.

3. **For email alerts,** verify the sender address in SES in the primary
   region. A new SES account is in the sandbox and can only send to
   verified recipients until you request production access.

4. **For SMS alerts,** set up SNS text messaging in the primary region.
   Many countries need an origination number or sender ID first.

## Deploy

Deploy the primary region first, since it creates the bucket:

```sh
sam build
sam deploy --region us-east-1 --stack-name belltower --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Regions=us-east-1,eu-west-1 PrimaryRegion=us-east-1 \
    BucketName=belltower-monitor-data-example EmailFrom=alerts@example.com
```

Then the same command for each other region, changing only `--region`:

```sh
sam deploy --region eu-west-1 --stack-name belltower --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Regions=us-east-1,eu-west-1 PrimaryRegion=us-east-1 \
    BucketName=belltower-monitor-data-example EmailFrom=alerts@example.com
```

The primary stack's `HeartbeatBaseUrl` output is where jobs send their
pings: `<HeartbeatBaseUrl>hb/<token>` on success, and `/fail` added on
failure.

To publish the status page, add `SiteUrl=https://status.example.com/` to
the primary region's parameters. `decide()` then rebuilds the page into the
bucket's `public/` folder, beside `status.json`, whenever an incident opens
or resolves and at least every 10 minutes. Serve that folder from any
static host. A theme in the config must be inline or a URL here, since the
Lambda can't read files from your repository.

## Check it's working

Each function logs one JSON line per run. Within two minutes of the last
deploy you should see a results file per region, and `public/status.json`:

```sh
aws s3 ls s3://belltower-monitor-data-example/results/ --recursive | tail
aws s3 cp s3://belltower-monitor-data-example/public/status.json -
```

If a function fails at cold start, its log lists every missing setting and
config error at once.
