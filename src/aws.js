const { EC2Client, RunInstancesCommand, TerminateInstancesCommand, waitUntilInstanceRunning, waitUntilInstanceStopped, StartInstancesCommand, StopInstancesCommand  } = require('@aws-sdk/client-ec2');
const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  const cd = config.input.runnerHomeDir ? 'cd ~' : `cd "${config.input.runnerHomeDir}"`;
  const download = config.input.runnerHomeDir ? '' : `
case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=\${ARCH}
curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-\${RUNNER_ARCH}-2.313.0.tar.gz
tar xzf ./actions-runner-linux-\${RUNNER_ARCH}-2.313.0.tar.gz
`;

  // If runner home directory is specified, we expect the actions-runner software (and dependencies)
  // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
  return `#!/bin/bash
cat << 'EOF' > /setup-runner.sh
${cd}
mkdir -p actions-runner && cd actions-runner
echo "${config.input.preRunnerScript}" > pre-runner-script.sh
source pre-runner-script.sh
${download}
export RUNNER_ALLOW_RUNASROOT=1
./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}
./run.sh
EOF

chmod +x /setup-runner.sh
USER_1000=$(getent passwd "1000" | cut -d: -f1)
if [ -z "$USER_1000" ]; then
  echo "No user with UID 1000 found. Running as root."
  /setup-runner.sh
else
  su - $USER_1000 -c "/setup-runner.sh"
fi
`;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new EC2Client();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MaxCount: 1,
    MinCount: 1,
    SecurityGroupIds: [config.input.securityGroupId],
    SubnetId: config.input.subnetId,
    UserData: Buffer.from(userData).toString('base64'),
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications
  };

  try {
    const result = await ec2.send(new RunInstancesCommand(params));
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function resumeEc2Instance(ec2InstanceId) {
  const ec2 = new EC2Client();

  try {
    await ec2.send(new StartInstancesCommand({InstanceIds: [ec2InstanceId]})).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
 } catch (error) {
   core.error('AWS EC2 instance starting error');
   throw error;
 }

}

async function stopEc2Instance() {
  const ec2 = new EC2Client();

 const params = {
   InstanceIds: [config.input.ec2InstanceId],
 };

 try {
   core.info(`AWS EC2 instance ${config.input.ec2InstanceId} stopping`);
   await ec2.send(new StopInstancesCommand(params)).promise();
   core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is stopped`);
   return;
 } catch (error) {
   core.error(`AWS EC2 instance ${config.input.ec2InstanceId} stop error`);
   throw error;
 }
}

async function terminateEc2Instance() {
  const ec2 = new EC2Client();

  const params = {
    InstanceIds: [config.input.ec2InstanceId]
  };

  try {
    await ec2.send(new TerminateInstancesCommand(params));
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceStopped(ec2InstanceId) {
  const ec2 = new EC2Client();

  try {
    await waitUntilInstanceStopped(
      {
        client: ec2,
        maxWaitTime: 300,
      }, {
      Filters: [
        {
          Name: 'instance-id',
          Values: [
            ec2InstanceId,
          ],
        },
      ],
    });
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} stopped error`);
    throw error;
  }
}

async function startRunner(ec2InstanceId) {
  const ssm = new SSMClient();

  const commands = [
    'cd ~/actions-runner/',
    './run.sh',
  ];

  const params = {
    DocumentName: 'AWS-RunShellScript',
    Targets: [{'Key':'InstanceIds', 'Values':[ec2InstanceId]}],
    Parameters: {'commands': [commands]},
  }

  try {
    core.info('Sending command to start GitHub runner')
    ssm.send(new SendCommandCommand(params));
  } catch (error) {
    core.error('Could not send command to instance');
  }
}


async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new EC2Client();
  try {
    core.info(`Cheking for instance ${ec2InstanceId} to be up and running`)
    await waitUntilInstanceRunning(
      {
        client: ec2,
        maxWaitTime: 300,
      }, {
      Filters: [
        {
          Name: 'instance-id',
          Values: [
            ec2InstanceId,
          ],
        },
      ],
    });

    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
  resumeEc2Instance,
  stopEc2Instance,
  waitForInstanceStopped,
  startRunner,
};
