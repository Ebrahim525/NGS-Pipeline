
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/ngs
ENV CONDA_DIR=/opt/conda

# Make VEP from the Conda environment available globally
ENV PATH=/opt/conda/envs/vep_env/bin:/opt/conda/bin:$PATH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Java 17, samtools, bwa, and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    unzip \
    bzip2 \
    xz-utils \
    build-essential \
    perl \
    openjdk-17-jdk \
    samtools \
    bwa \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 and npm
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Miniconda
RUN wget -q https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh \
    -O /tmp/miniconda.sh \
    && bash /tmp/miniconda.sh -b -p "$CONDA_DIR" \
    && rm /tmp/miniconda.sh

# Configure Conda
RUN conda config --system --add channels defaults \
    && conda config --system --add channels bioconda \
    && conda config --system --add channels conda-forge \
    && conda config --system --set channel_priority strict \
    && conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main \
    && conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r

# Install VEP 115 inside the Docker image
RUN conda create -n vep_env -y \
    ensembl-vep=115 \
    perl-dbi=1.651 \
    && conda clean -afy

# Create non-root user and frontend directory
RUN useradd -m -s /bin/bash ngs \
    && mkdir -p /home/ngs/ngs-pipeline/frontend \
    && chown -R ngs:ngs /home/ngs

# Use non-root user
USER ngs

WORKDIR /home/ngs/ngs-pipeline/frontend

# Frontend port
EXPOSE 5173

# Start frontend
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
