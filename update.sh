function update {
  cd src/$1
  git pull
  cd ../..
}

update nav2djs
update rosjs
update actionlibjs
update map2djs
