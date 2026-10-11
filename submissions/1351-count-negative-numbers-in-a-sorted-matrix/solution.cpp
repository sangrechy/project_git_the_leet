class Solution {
public:
    int countNegatives(vector<vector<int>>& grid) {
        int a=0;
        for (vector<int> i :grid){
            for (int j:i){
                if (j<0){
                    a++;
                }
            }
        }
        return a;
    }
};